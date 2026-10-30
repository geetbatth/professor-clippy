/** Route and Durable Object tests, run inside workerd. The Graph API is always mocked. */
import { WorkerToPc } from '@clippy/shared/relay';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ClippyDO, REMINDER_MAX_ATTEMPTS, REMINDER_RETRY_DELAYS_MS } from '../src/do';
import { nextOccurrence } from '../src/recurrence';
import { type WaMessage, mockGraph, sentText, signBody, webhookPayload } from './helpers';

const BASE = 'https://relay.test';
const LA = 'America/Los_Angeles';
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

/** Pretend a pending send retry is now due. */
function makeRetryDue(id: string): Promise<void> {
  return inDO((_i, s) => {
    s.storage.sql.exec('UPDATE reminders SET retry_at = ? WHERE id = ?', Date.now() - 1_000, id);
  });
}

function reminderRow(id: string): Promise<Record<string, SqlStorageValue> | undefined> {
  return inDO((_i, s) => s.storage.sql.exec('SELECT * FROM reminders WHERE id = ?', id).toArray()[0]);
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

  it('moves the 24 h window for non-text messages but queues only text', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await postWebhook(
      webhookPayload([{ from: env.MY_NUMBER, id: 'wamid.img', timestamp: String(ts), type: 'image' }]),
    );
    expect(res.status).toBe(200);
    expect(await inDO((i) => i.lastInboundAt())).toBe(ts * 1000);
    expect(await pending()).toEqual([]);
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


  it('PUT 400s FREQ=MINUTELY/SECONDLY, BYSECOND and an unknown tz', async () => {
    const t = Date.now() + HOUR;
    for (const [rrule, msg] of [
      ['FREQ=MINUTELY', 'Invalid RRULE: FREQ=MINUTELY is not supported'],
      ['FREQ=SECONDLY', 'Invalid RRULE: FREQ=SECONDLY is not supported'],
      ['FREQ=HOURLY;BYSECOND=5', 'Invalid RRULE: BYSECOND is not supported'],
    ] as const) {
      const res = await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: t, rrule });
      expect(res.status, rrule).toBe(400);
      expect(await res.json()).toEqual({ error: msg });
    }
    const badTz = await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: t, rrule: 'FREQ=DAILY', tz: 'Mars/Base' });
    expect(badTz.status).toBe(400);
    expect(JSON.stringify(await badTz.json())).toContain('Unknown IANA time zone');
    expect(await alarmAt()).toBeNull();
  });

  it('PUT stores tz and a re-PUT with a past dueAt keeps the Worker-advanced schedule', async () => {
    mockGraph();
    const rule = { rrule: 'FREQ=DAILY', tz: LA };
    await pcCall('/reminders/d', 'PUT', { body: 'Stretch', dueAt: Date.now() + HOUR, ...rule });
    const due = Date.now() - 60_000;
    await makeDue('d', due);
    await runDurableObjectAlarm(relay());
    const advanced = nextOccurrence('FREQ=DAILY', due, due, LA)!;
    expect(await reminderRow('d')).toMatchObject({ due_at: advanced, tz: LA, dtstart: due });

    // The PC (offline during the firing) re-syncs its stale, past dueAt: no duplicate firing.
    expect((await pcCall('/reminders/d', 'PUT', { body: 'Stretch!', dueAt: due, ...rule })).status).toBe(204);
    expect(await reminderRow('d')).toMatchObject({ body: 'Stretch!', due_at: advanced, dtstart: due });
    expect(await alarmAt()).toBe(advanced);

    // A changed rule, or a future dueAt, is an edit and replaces the schedule.
    const future = Date.now() + 3 * HOUR;
    await pcCall('/reminders/d', 'PUT', { body: 'Stretch!', dueAt: future, ...rule });
    expect(await reminderRow('d')).toMatchObject({ due_at: future, dtstart: future });
    await pcCall('/reminders/d', 'PUT', { body: 'Stretch!', dueAt: due, rrule: 'FREQ=WEEKLY', tz: LA });
    expect(await reminderRow('d')).toMatchObject({ due_at: due, rrule: 'FREQ=WEEKLY' });
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
    expect(fired).toEqual([
      { type: 'reminder-fired', id: expect.stringMatching(/^r1:\d+$/), reminderId: 'r1', firedAt: expect.any(Number), waId: 'wamid.1' },
    ]);
    expect(fired[0]!.id).toBe(`r1:${(fired[0] as { firedAt: number }).firedAt}`);
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
      {
        type: 'reminder-fired',
        id: expect.stringMatching(/^daily:/),
        reminderId: 'daily',
        firedAt: expect.any(Number),
        waId: 'wamid.1',
        nextDueAt: next,
      },
    ]);
    expect((await reminderRow('daily'))!.due_at).toBe(next);
    expect(await alarmAt()).toBe(next);
  });

  it('keeps every firing until acked; acking an older firing leaves the newer one', async () => {
    mockGraph();
    await pcCall('/reminders/daily', 'PUT', { body: 'Water plants', dueAt: Date.now() + HOUR, rrule: 'FREQ=DAILY' });
    await makeDue('daily', Date.now() - 2 * 24 * HOUR);
    await runDurableObjectAlarm(relay());
    await makeDue('daily', Date.now() - 1_000);
    await runDurableObjectAlarm(relay());
    const fired = await pending();
    expect(fired.map((f) => [f.type, (f as { reminderId: string }).reminderId, (f as { waId: string }).waId])).toEqual([
      ['reminder-fired', 'daily', 'wamid.1'],
      ['reminder-fired', 'daily', 'wamid.2'],
    ]);
    expect(fired[0]!.id).not.toBe(fired[1]!.id);
    const pc = await connectPc();
    await vi.waitFor(() => expect(pc.frames).toHaveLength(2));
    pc.ack([fired[0]!.id]); // a late ack for the older firing
    await vi.waitFor(async () => expect((await pending()).map((f) => f.id)).toEqual([fired[1]!.id]));
  });

  it('retries a transient send failure with backoff, then fires once it succeeds', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const graph = mockGraph((_c, n) =>
      n === 1 ? Response.json({ error: { message: 'Service unavailable', code: 2 } }, { status: 503 }) : undefined,
    );
    await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: Date.now() + HOUR });
    await makeDue('r1');
    const before = Date.now();
    await runDurableObjectAlarm(relay());

    expect(await pending()).toEqual([]); // nothing reported while retrying
    const row = (await reminderRow('r1'))!;
    expect(row.attempts).toBe(1);
    expect(row.retry_at).toBeGreaterThanOrEqual(before + REMINDER_RETRY_DELAYS_MS[0]!);
    expect(await alarmAt()).toBe(row.retry_at);
    expect(warned).toHaveBeenCalledWith(
      'reminder r1: send attempt 1/5 failed, retrying in 1 min: WhatsApp send failed: Service unavailable',
    );

    await makeRetryDue('r1');
    await runDurableObjectAlarm(relay());
    expect(graph).toHaveLength(2);
    expect(await pending()).toEqual([expect.objectContaining({ reminderId: 'r1', waId: 'wamid.2' })]);
    expect(await reminderRow('r1')).toBeUndefined();
    expect(await alarmAt()).toBeNull();
  });

  it('gives up after 5 transient failures (~30 min) and records the firing without waId', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost.'));
    await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: Date.now() + HOUR, rrule: 'FREQ=DAILY' });
    const due = Date.now() - 1_000;
    await makeDue('r1', due);
    await runDurableObjectAlarm(relay());
    for (let i = 1; i < REMINDER_MAX_ATTEMPTS; i++) {
      expect(await pending()).toEqual([]);
      expect((await reminderRow('r1'))!.attempts).toBe(i);
      await makeRetryDue('r1');
      await runDurableObjectAlarm(relay());
    }
    expect(REMINDER_MAX_ATTEMPTS).toBe(5);
    expect(REMINDER_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)).toBe(30 * 60_000);
    expect(globalThis.fetch).toHaveBeenCalledTimes(5);
    expect(warned).toHaveBeenCalledTimes(4);
    expect(logged).toHaveBeenCalledWith('reminder r1: giving up after 5 attempt(s): Network connection lost.');
    expect(await pending()).toEqual([
      { type: 'reminder-fired', id: expect.any(String), reminderId: 'r1', firedAt: expect.any(Number), nextDueAt: due + 24 * HOUR },
    ]);
    expect(await reminderRow('r1')).toMatchObject({ due_at: due + 24 * HOUR, attempts: 0, retry_at: null });
  });

  it('does not retry a permanent 4xx: records the firing without waId at once', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const graph = mockGraph(() =>
      Response.json({ error: { message: 'Template name does not exist', code: 132001 } }, { status: 404 }),
    );
    await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: Date.now() + HOUR });
    await makeDue('r1');
    await runDurableObjectAlarm(relay());
    expect(graph).toHaveLength(1);
    expect(await pending()).toEqual([
      { type: 'reminder-fired', id: expect.any(String), reminderId: 'r1', firedAt: expect.any(Number) },
    ]);
    expect(logged).toHaveBeenCalledWith(
      'reminder r1: giving up after 1 attempt(s): WhatsApp send failed: Template name does not exist',
    );
    expect(await alarmAt()).toBeNull();
  });

  it('does not advance a reminder that was replaced (PUT) or deleted while the send was in flight', async () => {
    const newDue = Date.now() + 5 * HOUR;
    mockGraph(async (_c, n) => {
      if (n === 1) await pcCall('/reminders/r1', 'PUT', { body: 'moved', dueAt: newDue });
      if (n === 2) await pcCall('/reminders/r2', 'DELETE');
      return undefined;
    });
    await pcCall('/reminders/r1', 'PUT', { body: 'x', dueAt: Date.now() + HOUR });
    await makeDue('r1');
    await runDurableObjectAlarm(relay());
    expect(await reminderRow('r1')).toMatchObject({ body: 'moved', due_at: newDue, dtstart: newDue });
    expect(await pending()).toEqual([expect.objectContaining({ reminderId: 'r1', waId: 'wamid.1', nextDueAt: newDue })]);
    expect(await alarmAt()).toBe(newDue);

    await pcCall('/reminders/r2', 'PUT', { body: 'y', dueAt: Date.now() + HOUR, rrule: 'FREQ=DAILY' });
    await makeDue('r2');
    await runDurableObjectAlarm(relay());
    expect(await reminderRow('r2')).toBeUndefined(); // the DELETE wins; nothing re-created
    const fired = (await pending()).find((f) => (f as { reminderId?: string }).reminderId === 'r2');
    expect(fired).toMatchObject({ waId: 'wamid.2' });
    expect(fired).not.toHaveProperty('nextDueAt');
  });

  it('finishes a reminder whose stored rule no longer parses (and still reports the firing)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockGraph();
    const due = Date.now() - 1_000;
    await inDO(async (_i, s) => {
      s.storage.sql.exec(
        'INSERT INTO reminders (id, body, due_at, rrule, tz, dtstart) VALUES (?, ?, ?, ?, NULL, ?)',
        'bad',
        'legacy',
        due,
        'FREQ=MINUTELY',
        due,
      );
      await s.storage.setAlarm(Date.now() + HOUR); // future, so only runDurableObjectAlarm runs it
    });
    await runDurableObjectAlarm(relay());
    expect(logged).toHaveBeenCalledWith('reminder bad: Invalid RRULE: FREQ=MINUTELY is not supported');
    expect(await reminderRow('bad')).toBeUndefined();
    expect(await pending()).toEqual([
      { type: 'reminder-fired', id: expect.any(String), reminderId: 'bad', firedAt: expect.any(Number), waId: 'wamid.1' },
    ]);
  });
});
