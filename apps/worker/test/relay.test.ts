/** Route and Durable Object tests, run inside workerd. The Graph API is always mocked. */
import { WorkerToPc } from '@clippy/shared/relay';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClippyDO } from '../src/do';
import { type WaMessage, mockGraph, sentText, signBody, webhookPayload } from './helpers';

const BASE = 'https://relay.test';
const AUTH = { authorization: `Bearer ${env.PC_SECRET}` };
const relay = () => env.CLIPPY.getByName('relay');

function call(path: string, init: RequestInit = {}): Promise<Response> {
  return exports.default.fetch(`${BASE}${path}`, init);
}

function pcCall(path: string, method: string, body?: unknown): Promise<Response> {
  return call(path, {
    method,
    headers: { ...AUTH, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

async function postWebhook(payload: unknown, signWith: string = env.APP_SECRET): Promise<Response> {
  const body = JSON.stringify(payload);
  return call('/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': await signBody(signWith, body) },
    body,
  });
}

function textFromMe(id: string, body: string, extra: Partial<WaMessage> = {}): WaMessage {
  return {
    from: env.MY_NUMBER,
    id,
    timestamp: String(Math.floor(Date.now() / 1000)),
    type: 'text',
    text: { body },
    ...extra,
  };
}

function inDO<R>(fn: (instance: ClippyDO, state: DurableObjectState) => R | Promise<R>): Promise<R> {
  return runInDurableObject(relay(), fn);
}

const pending = () => inDO((i) => i.pending());
const alarmAt = () => inDO((_i, s) => s.storage.getAlarm());

/** Pretend a stored reminder is now due (so the alarm handler will fire it). */
function makeDue(id: string, dueAt = Date.now() - 1_000): Promise<void> {
  return inDO((_i, s) => {
    s.storage.sql.exec('UPDATE reminders SET due_at = ?, dtstart = ? WHERE id = ?', dueAt, dueAt, id);
  });
}

interface PcSocket {
  ws: WebSocket;
  frames: WorkerToPc[];
  ack(ids: string[]): void;
}

const sockets: WebSocket[] = [];

async function connectPc(): Promise<PcSocket> {
  const res = await call('/ws', { headers: { ...AUTH, upgrade: 'websocket' } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  const frames: WorkerToPc[] = [];
  ws.addEventListener('message', (e) => {
    frames.push(WorkerToPc.parse(JSON.parse(String(e.data))));
  });
  ws.accept();
  sockets.push(ws);
  return { ws, frames, ack: (ids) => ws.send(JSON.stringify({ type: 'ack', ids })) };
}

beforeEach(async () => {
  await inDO(async (_i, s) => {
    s.storage.sql.exec('DELETE FROM outbox; DELETE FROM reminders; DELETE FROM kv; DELETE FROM sent; DELETE FROM seen;');
    await s.storage.deleteAlarm();
  });
});

afterEach(() => {
  for (const ws of sockets.splice(0)) ws.close(1000, 'test done');
  vi.restoreAllMocks();
});

describe('GET /webhook (verify handshake)', () => {
  it('echoes hub.challenge for the right verify token', async () => {
    const q = `hub.mode=subscribe&hub.verify_token=${env.VERIFY_TOKEN}&hub.challenge=12345`;
    const res = await call(`/webhook?${q}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('12345');
  });

  it('403s a wrong token or mode', async () => {
    expect((await call('/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status).toBe(403);
    const q = `hub.mode=unsubscribe&hub.verify_token=${env.VERIFY_TOKEN}&hub.challenge=1`;
    expect((await call(`/webhook?${q}`)).status).toBe(403);
    expect((await call('/webhook')).status).toBe(403);
  });
});

describe('POST /webhook', () => {
  it('403s a bad or missing signature and stores nothing', async () => {
    const payload = webhookPayload([textFromMe('wamid.x', 'hi')]);
    expect((await postWebhook(payload, 'wrong-secret')).status).toBe(403);
    const unsigned = await call('/webhook', { method: 'POST', body: JSON.stringify(payload) });
    expect(unsigned.status).toBe(403);
    expect(await pending()).toEqual([]);
    expect(await inDO((i) => i.lastInboundAt())).toBeUndefined();
  });

  it('queues texts from MY_NUMBER only and moves the 24 h window', async () => {
    const msgs = [
      textFromMe('wamid.1', 'line one\nline two'),
      { ...textFromMe('wamid.2', 'not me'), from: '15559998888' },
      textFromMe('wamid.3', 'yes', { context: { from: '15550001111', id: 'wamid.ask' } }),
    ];
    const res = await postWebhook(webhookPayload(msgs));
    expect(res.status).toBe(200);
    const ts = Number(msgs[0]!.timestamp) * 1000;
    expect(await pending()).toEqual([
      { type: 'inbound', id: 'wamid.1', text: 'line one\nline two', ts },
      { type: 'inbound', id: 'wamid.3', text: 'yes', contextWaId: 'wamid.ask', ts },
    ]);
    expect(await inDO((i) => i.lastInboundAt())).toBe(ts);
  });

  it('answers 200 to signed status-only or non-JSON bodies', async () => {
    expect((await postWebhook(webhookPayload([], { statuses: [{ id: 'wamid.o', status: 'read' }] }))).status).toBe(
      200,
    );
    const body = 'not json';
    const res = await call('/webhook', {
      method: 'POST',
      headers: { 'x-hub-signature-256': await signBody(env.APP_SECRET, body) },
      body,
    });
    expect(res.status).toBe(200);
    expect(await pending()).toEqual([]);
  });

  it('does not redeliver a webhook Meta retries after the PC acked it', async () => {
    const payload = webhookPayload([textFromMe('wamid.dup', 'once')]);
    await postWebhook(payload);
    const pc = await connectPc();
    await vi.waitFor(() => expect(pc.frames).toHaveLength(1));
    pc.ack(['wamid.dup']);
    await vi.waitFor(async () => expect(await pending()).toEqual([]));
    expect((await postWebhook(payload)).status).toBe(200);
    expect(await pending()).toEqual([]);
  });
});

describe('PC auth', () => {
  it('401s every PC route without the right bearer', async () => {
    const routes: [string, string][] = [
      ['/send', 'POST'],
      ['/reminders/r1', 'PUT'],
      ['/reminders/r1', 'DELETE'],
      ['/ws', 'GET'],
    ];
    for (const [path, method] of routes) {
      const variants: Record<string, string>[] = [
        {},
        { authorization: 'Bearer wrong' },
        { authorization: env.PC_SECRET },
      ];
      for (const headers of variants) {
        const res = await call(path, { method, headers: { ...headers, upgrade: 'websocket' } });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
  });

  it('404s unknown paths and keeps /health', async () => {
    expect((await call('/nope', { headers: AUTH })).status).toBe(404);
    expect(await (await call('/health')).json()).toEqual({ ok: true });
  });
});

describe('POST /send', () => {
  it('uses the clippy_note template when the user has not written in 24 h', async () => {
    const graph = mockGraph();
    const res = await pcCall('/send', 'POST', { text: 'Tests failed\n\n\tsee CI', kind: 'note', urgent: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ waId: 'wamid.1', mode: 'template' });
    expect(graph).toHaveLength(1);
    expect(graph[0]!.url).toBe(`https://graph.facebook.com/v24.0/${env.PHONE_NUMBER_ID}/messages`);
    expect(graph[0]!.auth).toBe(`Bearer ${env.META_TOKEN}`);
    expect(graph[0]!.body).toMatchObject({ to: env.MY_NUMBER, type: 'template', template: { name: 'clippy_note' } });
    expect(sentText(graph[0]!.body)).toBe('Tests failed · see CI');
    const kinds = await inDO((_i, s) => s.storage.sql.exec('SELECT wa_id, kind FROM sent').toArray());
    expect(kinds).toEqual([{ wa_id: 'wamid.1', kind: 'note' }]);
  });

  it('sends free-form text (newlines kept) inside the 24 h window', async () => {
    await postWebhook(webhookPayload([textFromMe('wamid.in', 'hi clippy')]));
    const graph = mockGraph();
    const res = await pcCall('/send', 'POST', { text: 'Hello\nthere', kind: 'chat' });
    expect(await res.json()).toEqual({ waId: 'wamid.1', mode: 'freeform' });
    expect(graph[0]!.body).toMatchObject({ type: 'text', text: { body: 'Hello\nthere' } });
  });

  it('400s an invalid body without calling Meta', async () => {
    const graph = mockGraph();
    expect((await pcCall('/send', 'POST', { text: '', kind: 'note' })).status).toBe(400);
    expect((await pcCall('/send', 'POST', { text: 'x', kind: 'shout' })).status).toBe(400);
    expect((await call('/send', { method: 'POST', headers: AUTH, body: '{' })).status).toBe(400);
    expect(graph).toHaveLength(0);
  });

  it('502s with the Meta error when the Graph API refuses', async () => {
    mockGraph(() => Response.json({ error: { message: 'Template not approved', code: 132001 } }, { status: 400 }));
    const res = await pcCall('/send', 'POST', { text: 'x', kind: 'note' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'WhatsApp send failed: Template not approved' });
  });

  it('502s when the Graph API is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost.'));
    const res = await pcCall('/send', 'POST', { text: 'x', kind: 'note' });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'Network connection lost.' });
  });

  it('405s a wrong method on a PC route', async () => {
    expect((await pcCall('/send', 'GET')).status).toBe(405);
  });
});

describe('GET /ws', () => {
  it('426s a non-upgrade request', async () => {
    expect((await call('/ws', { headers: AUTH })).status).toBe(426);
  });

  it('replays unacked items on connect, pushes new ones live, and ack removes them', async () => {
    await postWebhook(webhookPayload([textFromMe('wamid.a', 'first'), textFromMe('wamid.b', 'second')]));
    const pc = await connectPc();
    await vi.waitFor(() => expect(pc.frames.map((f) => f.id)).toEqual(['wamid.a', 'wamid.b']));

    await postWebhook(webhookPayload([textFromMe('wamid.c', 'live')]));
    await vi.waitFor(() => expect(pc.frames.map((f) => f.id)).toEqual(['wamid.a', 'wamid.b', 'wamid.c']));

    pc.ack(['wamid.a', 'wamid.c', 'unknown-id']);
    await vi.waitFor(async () => expect((await pending()).map((f) => f.id)).toEqual(['wamid.b']));
    pc.ws.close(1000, 'bye');

    const again = await connectPc();
    await vi.waitFor(() => expect(again.frames.map((f) => f.id)).toEqual(['wamid.b']));
  });

  it('ignores malformed frames from the PC', async () => {
    await postWebhook(webhookPayload([textFromMe('wamid.k', 'keep'), textFromMe('wamid.z', 'ack me')]));
    const pc = await connectPc();
    await vi.waitFor(() => expect(pc.frames).toHaveLength(2));
    pc.ws.send('not json');
    pc.ws.send(JSON.stringify({ type: 'ack', ids: 'wamid.k' }));
    pc.ws.send(JSON.stringify({ type: 'nack', ids: ['wamid.k'] }));
    pc.ack(['wamid.z']); // frames are handled in order, so once this lands the bad ones were too
    await vi.waitFor(async () => expect((await pending()).map((f) => f.id)).toEqual(['wamid.k']));
  });
});

describe('reminders', () => {
  const HOUR = 60 * 60 * 1000;

  it('PUT stores the reminder and arms the alarm at the earliest dueAt; DELETE re-arms', async () => {
    const t = Date.now();
    expect((await pcCall('/reminders/r1', 'PUT', { body: 'later', dueAt: t + 2 * HOUR })).status).toBe(204);
    expect((await pcCall('/reminders/r2', 'PUT', { body: 'sooner', dueAt: t + HOUR, rrule: 'FREQ=DAILY' })).status).toBe(
      204,
    );
    expect(await alarmAt()).toBe(t + HOUR);
    expect((await pcCall('/reminders/r2', 'DELETE')).status).toBe(204);
    expect(await alarmAt()).toBe(t + 2 * HOUR);
    expect((await pcCall('/reminders/r1', 'DELETE')).status).toBe(204);
    expect(await alarmAt()).toBeNull();
    expect((await pcCall('/reminders/missing', 'DELETE')).status).toBe(204);
  });

  it('PUT replaces an existing reminder', async () => {
    const t = Date.now();
    await pcCall('/reminders/r1', 'PUT', { body: 'v1', dueAt: t + HOUR });
    await pcCall('/reminders/r1', 'PUT', { body: 'v2', dueAt: t + 3 * HOUR, rrule: 'FREQ=WEEKLY' });
    const rows = await inDO((_i, s) => s.storage.sql.exec('SELECT id, body, due_at, rrule FROM reminders').toArray());
    expect(rows).toEqual([{ id: 'r1', body: 'v2', due_at: t + 3 * HOUR, rrule: 'FREQ=WEEKLY' }]);
    expect(await alarmAt()).toBe(t + 3 * HOUR);
  });

  it('PUT 400s a bad body or RRULE', async () => {
    const t = Date.now();
    expect((await pcCall('/reminders/r1', 'PUT', { body: 'x' })).status).toBe(400);
    expect((await pcCall('/reminders/r1', 'PUT', { body: '', dueAt: t })).status).toBe(400);
    const bad = await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: t, rrule: 'INTERVAL=2' });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'Invalid RRULE: FREQ is required' });
    expect(await alarmAt()).toBeNull();
  });

  it('alarm fires a due one-off: "⏰ " to WhatsApp, reminder-fired queued and pushed, reminder deleted', async () => {
    const graph = mockGraph();
    const pc = await connectPc();
    await pcCall('/reminders/r1', 'PUT', { body: 'Stand-up\nin 5', dueAt: Date.now() + HOUR });
    await pcCall('/reminders/r2', 'PUT', { body: 'not yet', dueAt: Date.now() + 2 * HOUR });
    await makeDue('r1');
    expect(await runDurableObjectAlarm(relay())).toBe(true);

    expect(graph).toHaveLength(1);
    expect(sentText(graph[0]!.body)).toBe('⏰ Stand-up · in 5'); // template (no inbound yet), sanitised
    const fired = await pending();
    expect(fired).toEqual([{ type: 'reminder-fired', id: 'r1', firedAt: expect.any(Number), waId: 'wamid.1' }]);
    await vi.waitFor(() => expect(pc.frames).toEqual(fired));
    const ids = await inDO((_i, s) => s.storage.sql.exec('SELECT id FROM reminders').toArray());
    expect(ids).toEqual([{ id: 'r2' }]);
    const kinds = await inDO((_i, s) => s.storage.sql.exec('SELECT kind FROM sent').toArray());
    expect(kinds).toEqual([{ kind: 'reminder' }]);
    expect(await alarmAt()).not.toBeNull(); // re-armed for r2
  });

  it('alarm advances a recurring reminder past now and reports nextDueAt', async () => {
    mockGraph();
    await postWebhook(webhookPayload([textFromMe('wamid.in', 'hi')])); // inside the window → free-form
    await pcCall('/reminders/daily', 'PUT', { body: 'Water plants', dueAt: Date.now() + HOUR, rrule: 'FREQ=DAILY' });
    const due = Date.now() - 5 * 60_000;
    await makeDue('daily', due);
    await runDurableObjectAlarm(relay());

    const next = due + 24 * HOUR;
    const fired = (await pending()).filter((f) => f.type === 'reminder-fired');
    expect(fired).toEqual([
      { type: 'reminder-fired', id: 'daily', firedAt: expect.any(Number), waId: 'wamid.1', nextDueAt: next },
    ]);
    const row = await inDO((_i, s) => s.storage.sql.exec('SELECT due_at FROM reminders WHERE id = ?', 'daily').one());
    expect(row.due_at).toBe(next);
    expect(await alarmAt()).toBe(next);
  });

  it('keeps one undelivered reminder-fired per reminder (the latest firing)', async () => {
    mockGraph();
    await pcCall('/reminders/daily', 'PUT', { body: 'Water plants', dueAt: Date.now() + HOUR, rrule: 'FREQ=DAILY' });
    await makeDue('daily', Date.now() - 2 * 24 * HOUR);
    await runDurableObjectAlarm(relay());
    await makeDue('daily', Date.now() - 1_000);
    await runDurableObjectAlarm(relay());
    const fired = await pending();
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ type: 'reminder-fired', id: 'daily', waId: 'wamid.2' });
  });

  it('still records the firing (without waId) when WhatsApp refuses', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGraph(() => Response.json({ error: { message: 'down', code: 1 } }, { status: 500 }));
    await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: Date.now() + HOUR });
    await makeDue('r1');
    await runDurableObjectAlarm(relay());
    expect(await pending()).toEqual([{ type: 'reminder-fired', id: 'r1', firedAt: expect.any(Number) }]);
    expect(logged).toHaveBeenCalledWith('reminder r1: WhatsApp send failed: down');
    expect(await alarmAt()).toBeNull();
  });
});
