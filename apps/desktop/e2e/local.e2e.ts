/**
 * Local end-to-end run of the real app (no WhatsApp, no brain turn):
 *
 *   npm run build                       (repo root: desktop, mcp, hook)
 *   npm run e2e -w apps/desktop         (Windows; takes ~1.5 min; leaves evidence in apps/desktop/out/e2e)
 *
 * Launches the built Electron app with a temp CLIPPY_HOME, then drives it the way agents do:
 * the built MCP server over stdio (leave_message, remind_me 1 min out, ask_user) and
 * `ClippyClient` (health, answer the ask, list state). Screenshots the Clippy window,
 * waits for the reminder to fire, then kills the app.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { ClippyClient } from '@clippy/shared';
import { afterAll, expect, it } from 'vitest';

const desktop = resolve(import.meta.dirname, '..');
const repo = resolve(desktop, '../..');
const mcpServer = join(repo, 'apps/mcp/dist/index.js');
const out = process.env.CLIPPY_E2E_OUT ?? join(desktop, 'out/e2e');
const home = mkdtempSync(join(tmpdir(), 'clippy-e2e-'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let app: ChildProcess | undefined;
let mcp: ChildProcess | undefined;
const transcript: unknown[] = [];

afterAll(async () => {
  mcp?.kill();
  if (app?.pid) spawnSync('taskkill', ['/pid', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  // The killed processes release the data dir a moment later.
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(home, { recursive: true, force: true });
      return;
    } catch {
      await sleep(500);
    }
  }
  console.warn(`could not remove ${home}`);
});

/** Minimal JSON-RPC client for the MCP server over stdio. */
function startMcp() {
  const child = spawn(process.execPath, [mcpServer], {
    env: { ...process.env, CLIPPY_HOME: home, CLIPPY_SENDER: 'e2e-agent' },
    cwd: repo,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<number, (msg: any) => void>();
  createInterface({ input: child.stdout! }).on('line', (line) => {
    const msg = JSON.parse(line);
    transcript.push({ '<-': msg });
    if (msg.id !== undefined) pending.get(msg.id)?.(msg);
  });
  let nextId = 1;
  const send = (msg: object) => {
    transcript.push({ '->': msg });
    child.stdin!.write(`${JSON.stringify(msg)}\n`);
  };
  const request = (method: string, params: object = {}) =>
    new Promise<any>((res) => {
      const id = nextId++;
      pending.set(id, res);
      send({ jsonrpc: '2.0', id, method, params });
    });
  const call = async (name: string, args: object) => {
    const r = await request('tools/call', { name, arguments: args });
    if (r.error || r.result?.isError) throw new Error(`${name} failed: ${JSON.stringify(r.error ?? r.result)}`);
    return r.result.content[0].text as string;
  };
  return { child, request, send, call };
}

function screenshot(name: string): unknown {
  const file = join(out, `${name}.png`);
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dirname, 'screenshot-window.ps1'), '-ProcessId', String(app!.pid), '-Out', file],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`screenshot failed: ${r.stderr}`);
  return { file, rect: JSON.parse(r.stdout.trim()) };
}

it('the real app takes a note, a reminder and an ask from an agent', { timeout: 180_000 }, async () => {
  expect(existsSync(join(desktop, 'out/main/index.js')), 'run npm run build first').toBe(true);
  expect(existsSync(mcpServer), 'run npm run build first').toBe(true);
  mkdirSync(out, { recursive: true });

  // ---- launch the app (as Electron, never as Node) ----
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const env: NodeJS.ProcessEnv = { ...process.env, CLIPPY_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  app = spawn(electron, [desktop], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = createWriteStream(join(out, 'app.log'));
  app.stdout!.pipe(log);
  app.stderr!.pipe(log);

  process.env.CLIPPY_HOME = home;
  let client: ClippyClient | undefined;
  for (let i = 0; i < 60 && !client; i++) {
    await sleep(500);
    client = await ClippyClient.fromAppData().catch(() => undefined);
  }
  expect(client, 'app did not come up').toBeDefined();
  const api = client!;
  const health = await api.health();
  const state = async () => ({
    unread: await api.listMessages({ state: 'unread' }),
    all: await api.listMessages(),
    reminders: await api.listReminders(),
    pendingAsks: await api.listPendingAsks(),
  });
  const before = await state();
  expect(before.all).toEqual([]);
  await sleep(2500); // let the window paint
  const shotStart = screenshot('1-mini-at-start');

  // ---- an agent talks to Clippy through the built MCP server ----
  const m = startMcp();
  mcp = m.child;
  const init = await m.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'clippy-e2e', version: '1' },
  });
  m.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const tools = (await m.request('tools/list')).result.tools.map((t: { name: string }) => t.name);
  const noteText = await m.call('leave_message', { title: 'E2E', body: 'Local end-to-end check: the build is green.' });
  const when = new Date(Date.now() + 60_000).toISOString();
  const reminderText = await m.call('remind_me', { body: 'E2E reminder: one minute is up.', when });
  const askText = await m.call('ask_user', { question: 'E2E: ship it?', options: ['yes', 'no'], timeout_s: 0 });
  const askId = (await api.listPendingAsks())[0]!.id;
  await sleep(2500); // Clippy jumps and opens the note
  const shotNote = screenshot('2-note-open');

  // ---- the user answers the ask (through the local API, as the desk would) ----
  const answered = await api.answerAsk(askId, 'yes, ship it', 'desk');
  const checkReply = await m.call('check_reply', { id: askId });
  const mid = await state();

  // ---- the reminder fires a minute later ----
  for (let i = 0; i < 90 && (await api.listMessages({ kind: 'reminder' })).length === 0; i++) await sleep(1000);
  await sleep(2500);
  const shotReminder = screenshot('3-reminder-fired');
  const after = await state();

  const brainMcp = JSON.parse(readFileSync(join(home, 'brain/brain-mcp.json'), 'utf8'));
  writeFileSync(
    join(out, 'evidence.json'),
    JSON.stringify(
      { home, health, tools, noteText, reminderText, askText, answered, checkReply, before, mid, after, brainMcp, screenshots: [shotStart, shotNote, shotReminder], transcript },
      null,
      2,
    ),
  );

  expect(init.result.serverInfo.name).toBe('clippy');
  expect(tools).toEqual(expect.arrayContaining(['leave_message', 'remind_me', 'ask_user', 'check_reply', 'answer_pending']));
  expect(answered).toMatchObject({ status: 'answered', answer: 'yes, ship it', answeredVia: 'desk' });
  expect(checkReply).toContain('yes, ship it');
  expect(mid.reminders).toHaveLength(1);
  expect(after.reminders).toEqual([]);
  const kinds = after.all.map((x) => `${x.kind}:${x.state}:${x.sender}`);
  expect(kinds).toEqual(['reminder:unread:e2e-agent', 'ask:done:e2e-agent', 'note:unread:e2e-agent']);
  expect(after.all.find((x) => x.kind === 'reminder')?.body).toBe('E2E reminder: one minute is up.');
  expect(brainMcp.mcpServers.clippy.env).toMatchObject({ CLIPPY_SENDER: 'clippy-brain', CLIPPY_HOME: home });
  expect(brainMcp.mcpServers.clippy.args).toEqual([mcpServer]);
});
