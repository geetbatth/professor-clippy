import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_LONG_POLL_S } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseWait } from '../../src/main/core/api';
import { Bus, type CoreEventMap } from '../../src/main/core/bus';
import { startCore, type Core, type StartCoreOptions } from '../../src/main/core/core';
import { FakeClock } from './fakeClock';

const T0 = Date.UTC(2026, 9, 30, 16);

describe('local API (raw HTTP)', () => {
  let dir: string;
  let clock: FakeClock;
  let core: Core;
  let base: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-api-'));
    clock = new FakeClock(T0);
    core = await startCore({ dataDir: dir, clock, version: '1.2.3' });
    base = `http://127.0.0.1:${core.port}`;
  });
  afterEach(async () => {
    await core.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const call = async (
    method: string,
    path: string,
    body?: unknown,
    auth: string | null = `Bearer ${core.token}`,
  ): Promise<{ status: number; json: unknown }> => {
    const headers: Record<string, string> = {};
    if (auth !== null) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : undefined };
  };

  describe('auth', () => {
    it.each([
      ['no header', null],
      ['wrong token', 'Bearer nope'],
      ['wrong scheme', 'Basic abc'],
      ['token without scheme', 'TOKEN'],
    ])('rejects %s with 401', async (_name, auth) => {
      const header = auth === 'TOKEN' ? core.token : auth;
      for (const [method, path] of [
        ['GET', '/health'],
        ['POST', '/messages'],
        ['GET', '/asks/pending'],
        ['GET', '/nope'],
      ] as const) {
        const res = await call(method, path, undefined, header);
        expect(res).toEqual({ status: 401, json: { error: 'Unauthorized' } });
      }
    });

    it('accepts the bearer token', async () => {
      expect(await call('GET', '/health')).toEqual({ status: 200, json: { ok: true, version: '1.2.3' } });
    });
  });

  describe('validation', () => {
    it.each([
      ['POST', '/messages', {}, /body/],
      ['POST', '/messages', { body: 'hi' }, /sender/],
      ['POST', '/messages', { body: '', sender: 's' }, /body/],
      ['POST', '/messages', '{not json', /valid JSON/],
      ['POST', '/messages', undefined, /valid JSON/],
      ['POST', '/reminders', { body: 'x', sender: 's', when: 'tomorrow at 9' }, /when/],
      ['POST', '/reminders', { body: 'x', sender: 's', when: '2026-11-01T09:00:00Z', rrule: 'FREQ=NOPE' }, /rrule/],
      ['POST', '/asks', { question: 'q', sender: 's', options: [''] }, /options/],
      ['GET', '/messages?state=bogus', undefined, /state/],
      ['GET', '/messages?kind=memo', undefined, /kind/],
    ])('%s %s %j → 400', async (method, path, body, error) => {
      const res = await call(method, path, body);
      expect(res.status).toBe(400);
      expect((res.json as { error: string }).error).toMatch(error);
    });

    it('validates snooze and answer bodies', async () => {
      const note = await call('POST', '/messages', { body: 'n', sender: 's' });
      const id = (note.json as { id: string }).id;
      expect((await call('POST', `/messages/${id}/snooze`, { until: 'soon' })).status).toBe(400);
      const ask = await call('POST', '/asks', { question: 'q', sender: 's' });
      const askId = (ask.json as { id: string }).id;
      expect((await call('POST', `/asks/${askId}/answer`, { answer: 'x', via: 'pigeon' })).status).toBe(400);
      expect((await call('POST', `/asks/${askId}/answer`, { answer: '', via: 'desk' })).status).toBe(400);
    });

    it.each(['abc', '-1', 'NaN', '1e3', ' 5', 'Infinity'])('rejects wait=%s with 400', async (wait) => {
      const ask = await call('POST', '/asks', { question: 'q', sender: 's' });
      const res = await call('GET', `/asks/${(ask.json as { id: string }).id}?wait=${encodeURIComponent(wait)}`);
      expect(res).toEqual({ status: 400, json: { error: 'wait must be a non-negative number of seconds' } });
    });
  });

  it('rejects a body over 1 MiB with 400 and accepts one just under', async () => {
    const overhead = JSON.stringify({ body: '', sender: 's' }).length;
    const big = await call('POST', '/messages', { body: 'x'.repeat(1024 * 1024 - overhead + 1), sender: 's' });
    expect(big).toEqual({ status: 400, json: { error: 'Request body too large (max 1 MiB)' } });
    const ok = await call('POST', '/messages', { body: 'x'.repeat(1024 * 1024 - overhead), sender: 's' });
    expect(ok.status).toBe(201);
  });

  it('parseWait defaults to 0 and clamps to MAX_LONG_POLL_S', () => {
    expect(parseWait(null)).toBe(0);
    expect(parseWait('')).toBe(0);
    expect(parseWait('2.5')).toBe(2.5);
    expect(parseWait('600')).toBe(MAX_LONG_POLL_S);
  });

  it('404s unknown routes and unknown ids', async () => {
    const unknown = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    expect((await call('GET', '/nope')).status).toBe(404);
    expect((await call('PUT', '/messages')).status).toBe(404);
    expect(await call('POST', `/messages/${unknown}/done`)).toEqual({ status: 404, json: { error: `No message ${unknown}` } });
    expect((await call('POST', `/messages/${unknown}/snooze`, { until: T0 })).status).toBe(404);
    expect((await call('DELETE', `/reminders/${unknown}`)).status).toBe(404);
    expect((await call('GET', `/asks/${unknown}?wait=0`)).status).toBe(404);
    expect((await call('POST', `/asks/${unknown}/answer`, { answer: 'x', via: 'desk' })).status).toBe(404);
  });

  it('answering an ask twice is 409', async () => {
    const ask = await call('POST', '/asks', { question: 'q', sender: 's' });
    const id = (ask.json as { id: string }).id;
    expect((await call('POST', `/asks/${id}/answer`, { answer: 'a', via: 'desk' })).status).toBe(200);
    const again = await call('POST', `/asks/${id}/answer`, { answer: 'b', via: 'whatsapp' });
    expect(again.status).toBe(409);
    expect((again.json as { error: string }).error).toMatch(/already answered/);
  });

  it('long-polls until the wait (clamped to MAX_LONG_POLL_S) expires, then returns pending', async () => {
    const ask = await call('POST', '/asks', { question: 'q', sender: 's' });
    const id = (ask.json as { id: string }).id;
    const polling = call('GET', `/asks/${id}?wait=600`);
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(1));
    expect(clock.nextAt).toBe(T0 + MAX_LONG_POLL_S * 1000);
    clock.advance(MAX_LONG_POLL_S * 1000);
    expect(await polling).toEqual({ status: 200, json: { id, status: 'pending' } });
  });

  it('a long-poll returns as soon as the ask is answered', async () => {
    const ask = await call('POST', '/asks', { question: 'q', sender: 's' });
    const id = (ask.json as { id: string }).id;
    const polling = call('GET', `/asks/${id}?wait=30`);
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(1));
    await call('POST', `/asks/${id}/answer`, { answer: 'go', via: 'whatsapp' });
    expect(await polling).toEqual({ status: 200, json: { id, status: 'answered', answer: 'go', answeredVia: 'whatsapp' } });
  });

  it('a client that disconnects mid long-poll is dropped', async () => {
    const ask = await call('POST', '/asks', { question: 'q', sender: 's' });
    const id = (ask.json as { id: string }).id;
    const controller = new AbortController();
    const polling = fetch(`${base}/asks/${id}?wait=30`, {
      headers: { authorization: `Bearer ${core.token}` },
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(1));
    controller.abort();
    await expect(polling).rejects.toThrow();
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(0));
  });

  it('POST /approvals: 400 for a bad body, 200 off by default (startCore), 201 waiting when on; withdraw is 204', async () => {
    expect((await call('POST', '/approvals', { tool: '', sender: 's' })).status).toBe(400);
    expect((await call('POST', '/approvals', { tool: 'Bash', input: {} })).status).toBe(400);
    expect(await call('POST', '/approvals', { tool: 'Bash', input: { command: 'ls' }, sender: 's' })).toEqual({ status: 200, json: { status: 'off' } });
    await core.stop();
    core = await startCore({ dataDir: dir, clock, approvalsEnabled: () => true });
    base = `http://127.0.0.1:${core.port}`;
    const waiting = await call('POST', '/approvals', { tool: 'Bash', input: { command: 'ls' }, sender: 's' });
    expect(waiting).toEqual({ status: 201, json: { status: 'waiting', id: expect.any(String) } });
    const id = (waiting.json as { id: string }).id;
    expect(await call('POST', `/approvals/${id}/withdraw`)).toEqual({ status: 204, json: undefined });
    expect((await call('GET', `/asks/${id}?wait=0`)).json).toMatchObject({ status: 'answered', answer: 'Withdrawn' });
    expect((await call('POST', '/approvals/01ARZ3NDEKTSV4RRFFQ69G5FAV/withdraw')).status).toBe(204);
  });

  it('DELETE /reminders/:id returns 204 with no body', async () => {
    const created = await call('POST', '/reminders', { body: 'x', sender: 's', when: '2026-11-01T09:00:00Z' });
    expect(created.status).toBe(201);
    const res = await call('DELETE', `/reminders/${(created.json as { id: string }).id}`);
    expect(res).toEqual({ status: 204, json: undefined });
    expect((await call('GET', '/reminders')).json).toEqual([]);
  });

  it('only listens on 127.0.0.1', async () => {
    await expect(fetch(`http://[::1]:${core.port}/health`)).rejects.toThrow();
  });
});

describe('standing orders', () => {
  let dir: string;
  let core: Core | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-orders-'));
  });
  afterEach(async () => {
    await core?.stop();
    core = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const start = async (options: Partial<StartCoreOptions> = {}) => {
    core = await startCore({ dataDir: dir, clock: new FakeClock(T0), ...options });
    return async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`http://127.0.0.1:${core!.port}${path}`, {
        method,
        headers: { authorization: `Bearer ${core!.token}`, ...(body !== undefined && { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: (text ? JSON.parse(text) : undefined) as any };
    };
  };
  const ASK = { question: 'Which branch?', options: ['main', 'staging'], sender: 'claude-code', project: 'clippy' };

  it('adds, lists oldest first and cancels orders', async () => {
    const call = await start();
    const first = await call('POST', '/orders', { text: 'say staging' });
    expect(first).toMatchObject({ status: 201, json: { text: 'say staging', active: true } });
    await call('POST', '/orders', { text: 'say yes' });
    expect((await call('GET', '/orders')).json.map((o: { text: string }) => o.text)).toEqual(['say staging', 'say yes']);

    expect(await call('DELETE', `/orders/${first.json.id}`)).toEqual({ status: 204, json: undefined });
    expect((await call('GET', '/orders')).json.map((o: { text: string }) => o.text)).toEqual(['say yes']);
    expect((await call('DELETE', '/orders/01JB2Z3K4M5N6P7Q8R9S0T1V2Z')).status).toBe(404);
  });

  it('validates the order text (1 to 500 characters)', async () => {
    const call = await start();
    expect((await call('POST', '/orders', { text: '' })).status).toBe(400);
    expect((await call('POST', '/orders', { text: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('POST', '/orders', {})).status).toBe(400);
  });

  it('adds, lists oldest first and cancels watches, defaulting the event to finished', async () => {
    const call = await start();
    const first = await call('POST', '/watches', { project: 'payments', nudge: 'Deploy' });
    expect(first).toMatchObject({ status: 201, json: { project: 'payments', event: 'finished', nudge: 'Deploy', active: true } });
    await call('POST', '/watches', { event: 'any', nudge: 'Look' });
    expect((await call('GET', '/watches')).json.map((w: { nudge: string }) => w.nudge)).toEqual(['Deploy', 'Look']);

    expect(await call('DELETE', `/watches/${first.json.id}`)).toEqual({ status: 204, json: undefined });
    expect((await call('GET', '/watches')).json.map((w: { nudge: string }) => w.nudge)).toEqual(['Look']);
    expect((await call('DELETE', '/watches/01JB2Z3K4M5N6P7Q8R9S0T1V2Z')).status).toBe(404);
  });

  it('validates a watch', async () => {
    const call = await start();
    expect((await call('POST', '/watches', { nudge: '' })).status).toBe(400);
    expect((await call('POST', '/watches', { nudge: 'x'.repeat(501) })).status).toBe(400);
    expect((await call('POST', '/watches', { project: '', nudge: 'x' })).status).toBe(400);
    expect((await call('POST', '/watches', { event: 'soon', nudge: 'x' })).status).toBe(400);
    expect((await call('POST', '/watches', {})).status).toBe(400);
  });

  it('keeps the event a note was posted with', async () => {
    const call = await start();
    const note = await call('POST', '/messages', { body: 'done', sender: 'claude-code', event: 'agent-finished' });
    expect(note).toMatchObject({ status: 201, json: { event: 'agent-finished' } });
    expect((await call('POST', '/messages', { body: 'x', sender: 's', event: 'bogus' })).status).toBe(400);
  });

  it('answers an ask at once when matchOrder finds an order for it', async () => {
    const matchOrder = vi.fn(async () => ({ orderId: '01JB2Z3K4M5N6P7Q8R9S0T1V2A', answer: 'staging' }));
    const call = await start({ matchOrder });
    const res = await call('POST', '/asks', ASK);
    expect(res.status).toBe(201);
    expect(matchOrder).toHaveBeenCalledWith(expect.objectContaining({ question: 'Which branch?', options: ['main', 'staging'] }));
    expect(res.json).toMatchObject({
      kind: 'ask',
      body: 'Which branch?',
      state: 'done',
      answer: 'staging',
      answeredVia: 'clippy',
      orderId: '01JB2Z3K4M5N6P7Q8R9S0T1V2A',
    });
    // The agent's long-poll gets the answer straight away, and nothing is left waiting on the user.
    expect((await call('GET', `/asks/${res.json.id}?wait=30`)).json).toEqual({
      id: res.json.id,
      status: 'answered',
      answer: 'staging',
      answeredVia: 'clippy',
    });
    expect((await call('GET', '/asks/pending')).json).toEqual([]);
  });

  it.each([
    ['finds no order', async () => undefined],
    ['rejects', async () => Promise.reject(new Error('boom'))],
  ])('posts a normal unanswered ask when matchOrder %s', async (_name, matchOrder) => {
    const call = await start({ matchOrder });
    const res = await call('POST', '/asks', ASK);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ kind: 'ask', state: 'unread' });
    expect(res.json).not.toHaveProperty('answer');
    expect((await call('GET', '/asks/pending')).json).toHaveLength(1);
  });

  it('posts a normal ask when matchOrder takes longer than the limit', async () => {
    const matchOrder = () => new Promise<undefined>(() => {}); // never settles
    const call = await start({ matchOrder, matchOrderTimeoutMs: 30 });
    const res = await call('POST', '/asks', ASK);
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ state: 'unread' });
  });

  it('does not store the ask when the agent hangs up while the match is still running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const matchOrder = vi.fn(async () => {
      await gate;
      return { orderId: '01JB2Z3K4M5N6P7Q8R9S0T1V2A', answer: 'staging' };
    });
    await start({ matchOrder });
    const controller = new AbortController();
    const pending = fetch(`http://127.0.0.1:${core!.port}/asks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${core!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(ASK),
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(matchOrder).toHaveBeenCalled());
    controller.abort();
    await expect(pending).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150)); // let the server notice the closed connection
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(core!.store.listMessages({ kind: 'ask' })).toEqual([]);
  });

  it('is unchanged without a matcher', async () => {
    const call = await start();
    const res = await call('POST', '/asks', ASK);
    expect(res.json).toMatchObject({ state: 'unread' });
    expect(res.json).not.toHaveProperty('orderId');
  });
});

describe('startCore files', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-core-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates the token once, writes the port file, and removes it on stop', async () => {
    const first = await startCore({ dataDir: join(dir, 'nested') });
    const tokenFile = join(dir, 'nested', 'token');
    const portFile = join(dir, 'nested', 'port');
    expect(first.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(tokenFile, 'utf8')).toBe(first.token);
    expect(readFileSync(portFile, 'utf8')).toBe(String(first.port));
    expect(existsSync(join(dir, 'nested', 'clippy.db'))).toBe(true);
    expect(readdirSync(join(dir, 'nested')).filter((f) => f.endsWith('.tmp'))).toEqual([]); // atomic writes leave no temp files
    await first.stop();
    await first.stop(); // idempotent
    expect(existsSync(portFile)).toBe(false);

    const second = await startCore({ dataDir: join(dir, 'nested') });
    expect(second.token).toBe(first.token);
    expect(readFileSync(portFile, 'utf8')).toBe(String(second.port));
    await second.stop();
  });

  it('replaces a malformed token file', async () => {
    writeFileSync(join(dir, 'token'), 'not-a-token');
    const core = await startCore({ dataDir: dir });
    expect(core.token).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(dir, 'token'), 'utf8')).toBe(core.token);
    await core.stop();
  });

  it('defaults to the shared app data dir (CLIPPY_HOME)', async () => {
    vi.stubEnv('CLIPPY_HOME', dir);
    try {
      const core = await startCore();
      expect(readFileSync(join(dir, 'port'), 'utf8')).toBe(String(core.port));
      expect(readFileSync(join(dir, 'token'), 'utf8')).toBe(core.token);
      await core.stop();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('catches up missed reminders on start, with events on a caller-supplied bus', async () => {
    const clock = new FakeClock(T0);
    const first = await startCore({ dataDir: dir, clock });
    const reminder = first.scheduler.create({ body: 'stretch', sender: 's', when: new Date(T0 + 60_000).toISOString() });
    await first.stop();

    clock.jump(3_600_000); // app was closed when the reminder came due
    const bus = new Bus();
    const fired: CoreEventMap['reminder:fired'][] = [];
    bus.on('reminder:fired', (e) => fired.push(e));
    const second = await startCore({ dataDir: dir, clock, bus });
    expect(second.bus).toBe(bus);
    expect(fired).toEqual([
      { reminder: expect.objectContaining({ id: reminder.id, active: false }), message: expect.objectContaining({ missed: true }) },
    ]);
    await second.stop();
  });

  it('stop() answers pending long-polls with pending instead of dropping them', async () => {
    const core = await startCore({ dataDir: dir });
    const ask = core.asks.create({ question: 'q', sender: 's' });
    const polling = fetch(`http://127.0.0.1:${core.port}/asks/${ask.id}?wait=30`, {
      headers: { authorization: `Bearer ${core.token}` },
    });
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(1));
    await core.stop();
    const res = await polling;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: ask.id, status: 'pending' });
  });
});
