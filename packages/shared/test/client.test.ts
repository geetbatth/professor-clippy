import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClippyApiError, ClippyClient, ClippyNotRunningError } from '../src/client';
import type { AskResult, Message, Reminder, StandingOrder, Watch } from '../src/schemas';

const TOKEN = 'a'.repeat(64);
const ASK_ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2W';
const REM_ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2X';

interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | undefined;
  body: unknown;
}

const message = (over: Partial<Message> = {}): Message => ({
  id: ASK_ID,
  kind: 'note',
  body: 'hello',
  sender: 'test',
  urgent: false,
  state: 'unread',
  createdAt: 1000,
  ...over,
});

const ORDER_ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2Y';
const order: StandingOrder = { id: ORDER_ID, text: 'say staging', active: true, createdAt: 1000 };
const WATCH_ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2C';
const watch: Watch = { id: WATCH_ID, project: 'payments', event: 'finished', nudge: 'Deploy', active: true, createdAt: 1000 };
const reminder: Reminder = { id: REM_ID, body: 'stretch', sender: 'test', dueAt: 5000, active: true, createdAt: 1000 };

/** Tiny fake of the desktop app's local API. `answerAfterPolls` makes the ask answered on the Nth getAsk. */
function fakeApi() {
  const requests: Recorded[] = [];
  const state: { answerAfterPolls: number; polls: number; onPoll?: () => void } = { answerAfterPolls: Infinity, polls: 0 };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({
      method: req.method ?? '',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth: req.headers.authorization,
      body,
    });
    const send = (status: number, payload?: unknown) => {
      res.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
      res.end(payload === undefined ? undefined : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: 'unauthorized' });

    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case 'GET /health':
        return send(200, { ok: true, version: '0.1.0' });
      case 'POST /messages':
        if (body.body === 'slow') await new Promise((r) => setTimeout(r, 200));
        return send(201, message({ body: body.body, sender: body.sender, urgent: body.urgent ?? false }));
      case 'GET /messages':
        return send(200, [message(), message({ state: 'done', doneAt: 2000 })]);
      case `POST /messages/${ASK_ID}/done`:
        return send(200, message({ state: 'done', doneAt: 2000 }));
      case `POST /messages/${ASK_ID}/snooze`:
        return send(200, message({ state: 'snoozed', snoozedUntil: body.until }));
      case 'POST /reminders':
        return send(201, reminder);
      case 'GET /reminders':
        return send(200, [reminder]);
      case `DELETE /reminders/${REM_ID}`:
        return send(204);
      case 'GET /orders':
        return send(200, [order]);
      case 'POST /orders':
        return send(201, { ...order, text: body.text });
      case `DELETE /orders/${ORDER_ID}`:
        return send(204);
      case 'GET /watches':
        return send(200, [watch]);
      case 'POST /watches':
        return send(201, { ...watch, ...body });
      case `DELETE /watches/${WATCH_ID}`:
        return send(204);
      case 'POST /asks':
        if (body.question === 'slow') await new Promise((r) => setTimeout(r, 200));
        return send(201, message({ kind: 'ask', body: body.question, options: body.options }));
      case 'GET /asks/pending':
        return send(200, [message({ kind: 'ask' })]);
      case `GET /asks/${ASK_ID}`: {
        state.polls += 1;
        state.onPoll?.();
        const result: AskResult =
          state.polls >= state.answerAfterPolls
            ? { id: ASK_ID, status: 'answered', answer: 'yes', answeredVia: 'whatsapp' }
            : { id: ASK_ID, status: 'pending' };
        return send(200, result);
      }
      case `POST /asks/${ASK_ID}/answer`:
        return send(200, { id: ASK_ID, status: 'answered', answer: body.answer, answeredVia: body.via });
      case 'POST /power/restart-app':
        return send(202, { id: ASK_ID, status: 'awaiting-confirmation', question: `Restart ${body.name}?` });
      case 'POST /power/restart-pc':
        return send(202, { id: ASK_ID, status: 'awaiting-confirmation', question: 'Restart your PC?' });
      case 'GET /power/apps':
        return send(200, [{ name: 'chrome', pid: 42, title: 'Inbox' }]);
      case 'POST /approvals':
        return body.tool === 'Bash' ? send(201, { status: 'waiting', id: ASK_ID }) : send(200, { status: 'at-desk' });
      case `POST /approvals/${ASK_ID}/withdraw`:
        return send(204);
      case 'POST /look':
        return send(200, { theme: body.theme ?? 'classic', followSystemDark: body.followSystemDark ?? false, darkTheme: body.darkTheme ?? 'night' });
      case 'GET /broken':
        return send(200, { not: 'a message' });
      default:
        return send(404, { error: `no route ${route}` });
    }
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      res.writeHead(500);
      res.end(String(err));
    });
  });
  return { server, requests, state };
}

let api: ReturnType<typeof fakeApi>;
let port: number;
let client: ClippyClient;

beforeAll(async () => {
  api = fakeApi();
  await new Promise<void>((resolve) => api.server.listen(0, '127.0.0.1', resolve));
  port = (api.server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => api.server.close(() => resolve()));
});

beforeEach(() => {
  api.requests.length = 0;
  api.state.polls = 0;
  api.state.answerAfterPolls = Infinity;
  api.state.onPoll = undefined;
  client = new ClippyClient({ baseUrl: `http://127.0.0.1:${port}/`, token: TOKEN, longPollChunkS: 1 });
});

const last = () => api.requests.at(-1)!;

describe('ClippyClient requests', () => {
  it('sends the bearer token and parses /health', async () => {
    await expect(client.health()).resolves.toEqual({ ok: true, version: '0.1.0' });
    expect(last()).toMatchObject({ method: 'GET', path: '/health', auth: `Bearer ${TOKEN}` });
  });

  it('posts a message', async () => {
    const msg = await client.postMessage({ body: 'Build done', sender: 'claude-code', project: 'p', urgent: true });
    expect(msg).toMatchObject({ body: 'Build done', sender: 'claude-code', urgent: true });
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/messages',
      body: { body: 'Build done', sender: 'claude-code', project: 'p', urgent: true },
    });
  });

  it('lists messages with only the given filters in the query', async () => {
    const list = await client.listMessages({ state: 'done', q: 'deploy failed' });
    expect(list).toHaveLength(2);
    expect(last()).toMatchObject({ method: 'GET', path: '/messages', query: { state: 'done', q: 'deploy failed' } });
    await client.listMessages();
    expect(last().query).toEqual({});
  });

  it('marks done and snoozes', async () => {
    expect((await client.markDone(ASK_ID)).state).toBe('done');
    expect(last()).toMatchObject({ method: 'POST', path: `/messages/${ASK_ID}/done` });
    expect((await client.snooze(ASK_ID, 9999)).snoozedUntil).toBe(9999);
    expect(last()).toMatchObject({ path: `/messages/${ASK_ID}/snooze`, body: { until: 9999 } });
  });

  it('creates, lists and cancels reminders', async () => {
    const input = { body: 'stretch', when: '2026-10-30T15:00:00Z', rrule: 'FREQ=DAILY', sender: 'test' };
    await expect(client.createReminder(input)).resolves.toEqual(reminder);
    expect(last()).toMatchObject({ method: 'POST', path: '/reminders', body: input });
    await expect(client.listReminders()).resolves.toEqual([reminder]);
    await expect(client.cancelReminder(REM_ID)).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', path: `/reminders/${REM_ID}` });
  });

  it('lists, adds and cancels standing orders', async () => {
    await expect(client.listOrders()).resolves.toEqual([order]);
    expect(last()).toMatchObject({ method: 'GET', path: '/orders' });
    await expect(client.addOrder('always say yes')).resolves.toMatchObject({ id: ORDER_ID, text: 'always say yes' });
    expect(last()).toMatchObject({ method: 'POST', path: '/orders', body: { text: 'always say yes' } });
    await expect(client.cancelOrder(ORDER_ID)).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', path: `/orders/${ORDER_ID}` });
  });

  it('lists, adds and cancels watches', async () => {
    await expect(client.listWatches()).resolves.toEqual([watch]);
    expect(last()).toMatchObject({ method: 'GET', path: '/watches' });
    await expect(client.addWatch({ project: 'api', nudge: 'Review' })).resolves.toMatchObject({ id: WATCH_ID, project: 'api', nudge: 'Review' });
    expect(last()).toMatchObject({ method: 'POST', path: '/watches', body: { project: 'api', nudge: 'Review' } });
    await expect(client.cancelWatch(WATCH_ID)).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'DELETE', path: `/watches/${WATCH_ID}` });
  });

  it('createAsk waits out the standing-order check, past the ordinary timeout', async () => {
    const impatient = new ClippyClient({ baseUrl: `http://127.0.0.1:${port}`, token: TOKEN, timeoutMs: 50 });
    // An ordinary call gives up on a 200 ms response; an ask allows MATCH_ORDER_TIMEOUT_MS more.
    await expect(impatient.postMessage({ body: 'slow', sender: 's' })).rejects.toBeInstanceOf(ClippyNotRunningError);
    await expect(impatient.createAsk({ question: 'slow', sender: 's' })).resolves.toMatchObject({ kind: 'ask', body: 'slow' });
  });

  it('creates asks, lists pending asks and answers them', async () => {
    const ask = await client.createAsk({ question: 'Ship it?', options: ['yes', 'no'], sender: 'codex' });
    expect(ask).toMatchObject({ id: ASK_ID, kind: 'ask', body: 'Ship it?', options: ['yes', 'no'] });
    expect(last()).toMatchObject({ method: 'POST', path: '/asks' });
    expect(await client.listPendingAsks()).toHaveLength(1);
    expect(last()).toMatchObject({ method: 'GET', path: '/asks/pending' });
    await expect(client.answerAsk(ASK_ID, 'no', 'clippy')).resolves.toEqual({
      id: ASK_ID,
      status: 'answered',
      answer: 'no',
      answeredVia: 'clippy',
    });
    expect(last()).toMatchObject({ path: `/asks/${ASK_ID}/answer`, body: { answer: 'no', via: 'clippy' } });
  });
});

describe('ClippyClient power requests', () => {
  it('requests an app restart, with and without a reason', async () => {
    await expect(client.restartApp('chrome', 'it froze')).resolves.toEqual({
      id: ASK_ID,
      status: 'awaiting-confirmation',
      question: 'Restart chrome?',
    });
    expect(last()).toMatchObject({ method: 'POST', path: '/power/restart-app', body: { name: 'chrome', reason: 'it froze' } });
    await client.restartApp('notepad');
    expect(last().body).toEqual({ name: 'notepad' });
  });

  it('requests a PC restart and lists open apps', async () => {
    await expect(client.restartPc()).resolves.toMatchObject({ status: 'awaiting-confirmation' });
    expect(last()).toMatchObject({ method: 'POST', path: '/power/restart-pc', body: {} });
    await client.restartPc('updates');
    expect(last().body).toEqual({ reason: 'updates' });
    await expect(client.listOpenApps()).resolves.toEqual([{ name: 'chrome', pid: 42, title: 'Inbox' }]);
    expect(last()).toMatchObject({ method: 'GET', path: '/power/apps' });
  });
});

describe('ClippyClient approvals', () => {
  it('requests an approval and withdraws it', async () => {
    const input = { sessionId: 's', cwd: '/x/payments', project: 'payments', tool: 'Bash', input: { command: 'npm test' }, sender: 'claude-code' };
    await expect(client.requestApproval(input)).resolves.toEqual({ status: 'waiting', id: ASK_ID });
    expect(last()).toMatchObject({ method: 'POST', path: '/approvals', body: input });
    await expect(client.requestApproval({ tool: 'Read', sender: 'a' })).resolves.toEqual({ status: 'at-desk' });
    await expect(client.withdrawApproval(ASK_ID)).resolves.toBeUndefined();
    expect(last()).toMatchObject({ method: 'POST', path: `/approvals/${ASK_ID}/withdraw` });
  });
});

describe('ClippyClient.setLook', () => {
  it('posts the patch and returns the resulting look', async () => {
    await expect(client.setLook({ theme: 'night' })).resolves.toEqual({ theme: 'night', followSystemDark: false, darkTheme: 'night' });
    expect(last()).toMatchObject({ method: 'POST', path: '/look', body: { theme: 'night' } });
  });
});

describe('ClippyClient.waitAsk', () => {
  it('passes wait=0 for a non-blocking check', async () => {
    await expect(client.waitAsk(ASK_ID, 0)).resolves.toEqual({ id: ASK_ID, status: 'pending' });
    expect(api.requests).toHaveLength(1);
    expect(last().query).toEqual({ wait: '0' });
  });

  it('long-polls in chunks until answered', async () => {
    api.state.answerAfterPolls = 3;
    await expect(client.waitAsk(ASK_ID, 600)).resolves.toMatchObject({ status: 'answered', answer: 'yes' });
    expect(api.requests).toHaveLength(3);
    expect(api.requests.every((r) => r.query.wait === '1')).toBe(true); // capped at longPollChunkS
  });

  it('returns pending once the wait runs out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const start = Date.now();
      api.state.onPoll = () => vi.setSystemTime(start + api.state.polls * 1000); // each poll "takes" 1 s
      await expect(client.waitAsk(ASK_ID, 3)).resolves.toEqual({ id: ASK_ID, status: 'pending' });
      expect(api.requests).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('ClippyClient errors', () => {
  it('throws ClippyApiError with the status and server message on non-2xx', async () => {
    const bad = new ClippyClient({ baseUrl: `http://127.0.0.1:${port}`, token: 'wrong' });
    const err = await bad.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClippyApiError);
    expect(err).toMatchObject({ status: 401, message: expect.stringContaining('unauthorized') });
    await expect(client.markDone('nope')).rejects.toMatchObject({ status: 404 });
  });

  it('throws ClippyNotRunningError when nothing is listening', async () => {
    const dead = new ClippyClient({ baseUrl: `http://127.0.0.1:${await closedPort()}`, token: TOKEN });
    await expect(dead.health()).rejects.toBeInstanceOf(ClippyNotRunningError);
  });
});

describe('ClippyClient.fromAppData', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'clippy-client-'));
    vi.stubEnv('CLIPPY_HOME', home);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  });

  it('reads port and token files (trimming whitespace) and connects', async () => {
    await writeFile(join(home, 'port'), `${port}\r\n`);
    await writeFile(join(home, 'token'), `${TOKEN}\n`);
    const fromFiles = await ClippyClient.fromAppData();
    expect(fromFiles.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(last().auth).toBe(`Bearer ${TOKEN}`);
  });

  it('throws ClippyNotRunningError when the files are missing', async () => {
    await expect(ClippyClient.fromAppData()).rejects.toBeInstanceOf(ClippyNotRunningError);
  });

  it('throws ClippyNotRunningError when the port file is garbage', async () => {
    await writeFile(join(home, 'port'), 'not-a-port');
    await writeFile(join(home, 'token'), TOKEN);
    await expect(ClippyClient.fromAppData()).rejects.toBeInstanceOf(ClippyNotRunningError);
  });

  it('throws ClippyNotRunningError when the app is unreachable', async () => {
    await writeFile(join(home, 'port'), String(await closedPort()));
    await writeFile(join(home, 'token'), TOKEN);
    await expect(ClippyClient.fromAppData()).rejects.toBeInstanceOf(ClippyNotRunningError);
  });
});

/** A port that was just free (bind then close). */
async function closedPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = (s.address() as AddressInfo).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}
