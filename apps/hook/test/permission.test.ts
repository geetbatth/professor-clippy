/**
 * The `PermissionRequest` hook against a fake app API: what it sends, how long it waits, and above
 * all that it prints `allow` only for an explicit Allow-type answer from the user.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AskResult } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAST_RESORT_MS, PERMISSION_LAST_RESORT_MS, lastResortMs, runHook } from '../src/hook';
import { DENIED_MESSAGE, HOOK_WAIT_S, decisionFor, hookOutput } from '../src/permission';

const TOKEN = 'c'.repeat(64);
const ASK_ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2W';
let home: string;
let server: Server | undefined;
let app: {
  requests: { method: string; url: string; body: any }[];
  /** What `POST /approvals` answers. */
  approval: { status: 'off' } | { status: 'at-desk' } | { status: 'waiting'; id: string };
  /** What the Nth `GET /asks/:id` answers (the last one repeats); pending answers are a short sleep. */
  polls: AskResult[];
  /** `GET /asks/:id` fails with this status instead. */
  pollStatus?: number;
};

async function startApp() {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('{"error":"no"}');
    app.requests.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
    res.setHeader('content-type', 'application/json');
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/health') return void res.end(JSON.stringify({ ok: true, version: 'fake' }));
    if (req.method === 'POST' && path === '/approvals') return void res.writeHead(201).end(JSON.stringify(app.approval));
    if (req.method === 'GET' && path === `/asks/${ASK_ID}`) {
      if (app.pollStatus) return void res.writeHead(app.pollStatus).end('{"error":"gone"}');
      const n = app.requests.filter((r) => r.url.startsWith(`/asks/${ASK_ID}?`)).length;
      const result = app.polls[Math.min(n, app.polls.length) - 1]!;
      if (result.status === 'pending') await new Promise((r) => setTimeout(r, 100));
      return void res.end(JSON.stringify(result));
    }
    if (req.method === 'POST' && path === `/approvals/${ASK_ID}/withdraw`) return void res.writeHead(204).end();
    res.writeHead(404).end('{"error":"nope"}');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  await writeFile(join(home, 'port'), String((server.address() as AddressInfo).port));
  await writeFile(join(home, 'token'), TOKEN);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clippy-permission-'));
  process.env.CLIPPY_HOME = home;
  app = { requests: [], approval: { status: 'waiting', id: ASK_ID }, polls: [{ id: ASK_ID, status: 'pending' }] };
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  delete process.env.CLIPPY_HOME;
  await rm(home, { recursive: true, force: true });
});

const permission = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    hook_event_name: 'PermissionRequest',
    session_id: 'sess-1',
    transcript_path: '/t.jsonl',
    cwd: join('code', 'payments'),
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'npm test', description: 'Run the tests' },
    ...over,
  });

const answered = (answer: string, answeredVia: AskResult['answeredVia'] = 'telegram'): AskResult => ({ id: ASK_ID, status: 'answered', answer, answeredVia });

/** Run the hook; returns its outcome and everything it printed. */
async function run(raw = permission(), waitS = 2) {
  const out: string[] = [];
  const outcome = await runHook(raw, { write: (t) => out.push(t), permissionWaitS: waitS, env: {} });
  return { outcome, out };
}

const allowJson = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const denyJson = (message: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message } } });

describe('PermissionRequest', () => {
  it('asks the app, waits, and prints allow when the user taps Allow', async () => {
    await startApp();
    app.polls = [{ id: ASK_ID, status: 'pending' }, answered('Allow')];
    expect(await run()).toEqual({ outcome: 'allowed', out: [allowJson] });
    expect(app.requests.find((r) => r.url === '/approvals')!.body).toEqual({
      sessionId: 'sess-1',
      cwd: join('code', 'payments'),
      project: 'payments',
      tool: 'Bash',
      input: { command: 'npm test', description: 'Run the tests' },
      sender: 'claude-code',
    });
    // It long-polls the ask; nothing is withdrawn once answered.
    expect(app.requests.some((r) => r.url.startsWith(`/asks/${ASK_ID}?wait=`))).toBe(true);
    expect(app.requests.some((r) => r.url.endsWith('/withdraw'))).toBe(false);
  });

  it('prints deny with the reason for Deny, and passes any other reply on to the agent', async () => {
    await startApp();
    app.polls = [answered('Deny', 'whatsapp')];
    expect(await run()).toEqual({ outcome: 'denied', out: [denyJson(DENIED_MESSAGE)] });
    expect(DENIED_MESSAGE).toBe('The user denied this from their phone.');
    app.requests = [];
    app.polls = [answered('use pnpm instead')];
    expect(await run()).toEqual({ outcome: 'denied', out: [denyJson('The user replied from their phone instead of allowing it: use pnpm instead')] });
  });

  it.each([
    ['off', { status: 'off' as const }],
    ['at the PC', { status: 'at-desk' as const }],
  ])('makes no decision when the app says %s', async (_, approval) => {
    await startApp();
    app.approval = approval;
    expect(await run()).toEqual({ outcome: 'no-decision', out: [] });
    expect(app.requests.map((r) => r.url)).toEqual(['/health', '/approvals']);
  });

  it('gives up after its wait: withdraws the question and makes no decision', async () => {
    await startApp();
    const started = Date.now();
    expect(await run(permission(), 1)).toEqual({ outcome: 'no-decision', out: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(app.requests.at(-1)).toMatchObject({ method: 'POST', url: `/approvals/${ASK_ID}/withdraw` });
  });

  it.each(['Expired', 'Withdrawn', 'Dismissed'])('takes Clippy closing it (%s) as no decision', async (answer) => {
    await startApp();
    app.polls = [answered(answer, 'clippy')];
    expect(await run()).toEqual({ outcome: 'no-decision', out: [] });
  });

  it('never sends AskUserQuestion to the phone (it needs the terminal)', async () => {
    await startApp();
    expect(await run(permission({ tool_name: 'AskUserQuestion', tool_input: { questions: [] } }))).toEqual({ outcome: 'no-decision', out: [] });
    expect(app.requests.some((r) => r.url === '/approvals')).toBe(false);
  });

  it('makes no decision when the app is not running or fails, and tries to withdraw', async () => {
    expect(await run()).toEqual({ outcome: 'not-running', out: [] });
    await startApp();
    app.pollStatus = 500;
    expect(await run()).toEqual({ outcome: 'no-decision', out: [] });
    expect(app.requests.at(-1)?.url).toBe(`/approvals/${ASK_ID}/withdraw`);
    app.approval = { nonsense: true } as never; // an app that answers garbage
    app.pollStatus = undefined;
    expect(await run()).toEqual({ outcome: 'no-decision', out: [] });
  });

  it('does nothing when the hook is turned off, or for the brain', async () => {
    await startApp();
    await writeFile(join(home, 'settings.json'), JSON.stringify({ hookEnabled: false }));
    expect(await run()).toEqual({ outcome: 'disabled', out: [] });
    await writeFile(join(home, 'settings.json'), '{}');
    expect(await runHook(permission(), { env: { CLIPPY_BRAIN: '1' }, write: () => expect.fail('wrote') })).toBe('ignored');
    expect(app.requests).toEqual([]);
  });

  it('waits up to 1740 s, and the CLI only gives up after that (under the 1800 s timeout)', () => {
    expect(HOOK_WAIT_S).toBe(1740);
    expect(lastResortMs(permission())).toBe(PERMISSION_LAST_RESORT_MS);
    expect(PERMISSION_LAST_RESORT_MS).toBeGreaterThan(HOOK_WAIT_S * 1000);
    expect(PERMISSION_LAST_RESORT_MS).toBeLessThan(1800 * 1000);
    expect(lastResortMs(JSON.stringify({ hook_event_name: 'Stop' }))).toBe(LAST_RESORT_MS);
    expect(lastResortMs('not json')).toBe(LAST_RESORT_MS);
  });
});

describe('decisionFor (the only source of allow)', () => {
  it.each(['Allow', 'allow', ' ALLOW ', 'yes', 'Y', 'ok', 'OK', 'approve', 'Approve'])('allows on %j', (answer) => {
    expect(decisionFor(answered(answer))).toEqual({ behavior: 'allow' });
    expect(decisionFor(answered(answer, 'desk'))).toEqual({ behavior: 'allow' });
  });

  it.each(['Deny', 'deny', 'No', ' no '])('denies on %j', (answer) => {
    expect(decisionFor(answered(answer))).toEqual({ behavior: 'deny', message: DENIED_MESSAGE });
  });

  it.each(['Expired', 'withdrawn', 'Dismissed', '', '   '])('makes no decision on %j', (answer) => {
    expect(decisionFor(answered(answer))).toBeUndefined();
  });

  it('never allows anything else: near misses and replies are denials that carry the text', () => {
    for (const answer of ['allow it', 'yes please', 'okay', 'Allow!', 'y es', 'sure', 'go ahead', 'Allowed']) {
      expect(decisionFor(answered(answer)), answer).toEqual({ behavior: 'deny', message: `The user replied from their phone instead of allowing it: ${answer}` });
    }
  });

  it('never decides on an answer from Clippy, or with no answer yet', () => {
    expect(decisionFor(answered('Allow', 'clippy'))).toBeUndefined();
    expect(decisionFor(answered('Deny', 'clippy'))).toBeUndefined();
    expect(decisionFor({ id: ASK_ID, status: 'pending' })).toBeUndefined();
    expect(decisionFor({ id: ASK_ID, status: 'answered' })).toBeUndefined();
  });

  it('hookOutput is the shape Claude Code reads', () => {
    expect(hookOutput({ behavior: 'allow' })).toBe(allowJson);
    expect(JSON.parse(hookOutput({ behavior: 'deny', message: 'm' }))).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'm' } },
    });
  });
});
