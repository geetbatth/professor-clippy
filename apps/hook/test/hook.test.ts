import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_LINE_CHARS, dedupeKey, hookStatePath, lastAssistantText, lastLine, runHook } from '../src/hook';

const TOKEN = 'b'.repeat(64);
let home: string;
let server: Server | undefined;
let posted: any[];

/** Minimal fake of the app API: /health and POST /messages. Writes port/token into the app data dir. */
async function startApp() {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end('{"error":"no"}');
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return void res.end(JSON.stringify({ ok: true, version: 'fake' }));
    if (req.method === 'POST' && req.url === '/messages') {
      const body = JSON.parse(raw);
      posted.push(body);
      const message = { id: '01JB2Z3K4M5N6P7Q8R9S0T1V2W', kind: 'note', state: 'unread', createdAt: 1, urgent: false, ...body };
      return void res.writeHead(201).end(JSON.stringify(message));
    }
    res.writeHead(404).end('{"error":"nope"}');
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  await writeFile(join(home, 'port'), String((server.address() as AddressInfo).port));
  await writeFile(join(home, 'token'), TOKEN);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clippy-hook-'));
  process.env.CLIPPY_HOME = home;
  posted = [];
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve));
  server = undefined;
  delete process.env.CLIPPY_HOME;
  await rm(home, { recursive: true, force: true });
});

const stop = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ hook_event_name: 'Stop', session_id: 's', cwd: 'C:\\code\\payments', stop_hook_active: false, ...over });

async function transcript(entries: unknown[], trailer = '\n'): Promise<string> {
  const path = join(home, 'transcript.jsonl');
  await writeFile(path, entries.map((e) => JSON.stringify(e)).join('\n') + trailer);
  return path;
}

const assistant = (content: unknown) => ({ type: 'assistant', message: { role: 'assistant', content } });

describe('Stop', () => {
  it('posts "✅ <project> agent finished" plus the last assistant line', async () => {
    await startApp();
    const path = await transcript([
      { type: 'user', message: { role: 'user', content: 'fix the tests' } },
      assistant([{ type: 'text', text: 'Looking.' }]),
      assistant([
        { type: 'text', text: 'All 42 tests pass.\n\nWant me to open a PR?  \n' },
        { type: 'tool_use', id: 't', name: 'x', input: {} },
      ]),
      assistant([{ type: 'tool_use', id: 't2', name: 'y', input: {} }]),
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    ]);
    expect(await runHook(stop({ transcript_path: path }))).toBe('posted');
    expect(posted).toEqual([
      { body: '✅ payments agent finished\nWant me to open a PR?', sender: 'claude-code', project: 'payments', quietIfActive: true },
    ]);
  });

  it('posts just the headline when the transcript is missing or unreadable', async () => {
    await startApp();
    expect(await runHook(stop({ transcript_path: join(home, 'nope.jsonl') }))).toBe('posted');
    expect(posted[0].body).toBe('✅ payments agent finished');
  });

  it('collapses duplicate Stops for the same working directory within 60 s', async () => {
    await startApp();
    let t = 1_000_000;
    const now = () => t;
    expect(await runHook(stop(), { now })).toBe('posted');
    t += 59_000;
    expect(await runHook(stop(), { now })).toBe('duplicate');
    expect(await runHook(stop({ cwd: 'c:\\CODE\\Payments' }), { now })).toBe('duplicate'); // same dir, other case
    expect(await runHook(stop({ cwd: 'C:\\work\\other' }), { now })).toBe('posted');
    t += 2_000; // 61 s after the first post
    expect(await runHook(stop(), { now })).toBe('posted');
    expect(posted.map((p) => p.project)).toEqual(['payments', 'other', 'payments']);
    expect(JSON.parse(await readFile(hookStatePath(), 'utf8'))).toEqual({
      lastStop: { [dedupeKey('C:\\code\\payments')]: 1_061_000, [dedupeKey('C:\\work\\other')]: 1_059_000 },
    });
  });

  it('does not collapse two different folders that share a name', async () => {
    await startApp();
    const now = () => 5_000_000;
    expect(await runHook(stop({ cwd: 'C:\\clients\\acme\\api' }), { now })).toBe('posted');
    expect(await runHook(stop({ cwd: 'C:\\clients\\globex\\api' }), { now })).toBe('posted');
    expect(posted.map((p) => p.project)).toEqual(['api', 'api']);
  });

  it('does not record a Stop that could not be posted', async () => {
    expect(await runHook(stop())).toBe('not-running');
    await startApp();
    expect(await runHook(stop())).toBe('posted');
  });
});

describe('Notification', () => {
  it('posts an urgent "🔐 <project>: <message>" note', async () => {
    await startApp();
    const raw = JSON.stringify({
      hook_event_name: 'Notification',
      cwd: '/home/me/clippy',
      message: 'Claude needs your permission to use Bash',
      notification_type: 'permission_prompt',
    });
    expect(await runHook(raw)).toBe('posted');
    expect(await runHook(raw)).toBe('posted'); // no dedupe for notifications
    // Permission prompts always interrupt: no quietIfActive (only Stop notes are away-only).
    expect(posted[0]).toEqual({
      body: '🔐 clippy: Claude needs your permission to use Bash',
      sender: 'claude-code',
      project: 'clippy',
      urgent: true,
    });
    expect(posted[0]).not.toHaveProperty('quietIfActive');
    expect(posted).toHaveLength(2);
  });

  it('ignores the idle prompt (Stop already covers it) and empty messages', async () => {
    await startApp();
    const base = { hook_event_name: 'Notification', cwd: '/x/p' };
    expect(await runHook(JSON.stringify({ ...base, message: 'Claude is waiting for your input', notification_type: 'idle_prompt' }))).toBe('ignored');
    expect(await runHook(JSON.stringify({ ...base, message: '  ' }))).toBe('ignored');
    expect(posted).toEqual([]);
  });
});

describe('guards', () => {
  it('does nothing when hookEnabled is false in settings.json', async () => {
    await startApp();
    await writeFile(join(home, 'settings.json'), JSON.stringify({ hookEnabled: false }));
    expect(await runHook(stop())).toBe('disabled');
    expect(await runHook(JSON.stringify({ hook_event_name: 'Notification', cwd: '/p', message: 'hi' }))).toBe('disabled');
    expect(posted).toEqual([]);
  });

  it('honours hookEnabled:false even when another settings field is invalid', async () => {
    await startApp();
    await writeFile(join(home, 'settings.json'), JSON.stringify({ hookEnabled: false, workerUrl: 'not a url', askTimeoutDefaultS: -1 }));
    expect(await runHook(stop())).toBe('disabled');
    expect(posted).toEqual([]);
  });

  it('treats a corrupt settings.json as defaults (enabled)', async () => {
    await startApp();
    await writeFile(join(home, 'settings.json'), '{not json');
    expect(await runHook(stop())).toBe('posted');
  });

  it('does nothing when the app is not running', async () => {
    expect(await runHook(stop())).toBe('not-running');
    await expect(runHook(JSON.stringify({ hook_event_name: 'Notification', cwd: '/p', message: 'hi' }))).resolves.toBe(
      'not-running',
    );
  });

  it('ignores garbage and other events', async () => {
    await startApp();
    for (const raw of ['', 'not json', 'null', '42', JSON.stringify({ hook_event_name: 'PreToolUse', cwd: '/p' })]) {
      expect(await runHook(raw)).toBe('ignored');
    }
    expect(posted).toEqual([]);
  });

  it("ignores Professor Clippy's own brain turns (CLIPPY_BRAIN=1)", async () => {
    await startApp();
    const env = { CLIPPY_BRAIN: '1' };
    expect(await runHook(stop(), { env })).toBe('ignored');
    expect(await runHook(JSON.stringify({ hook_event_name: 'Notification', cwd: '/p', message: 'hi' }), { env })).toBe(
      'ignored',
    );
    expect(posted).toEqual([]);
    expect(await runHook(stop(), { env: {} })).toBe('posted');
  });
});

describe('transcript helpers', () => {
  it('lastLine trims, skips blank lines and caps at 300 chars', () => {
    expect(lastLine('first\n\n  last one  \n\n')).toBe('last one');
    expect(lastLine(' \n ')).toBeUndefined();
    const long = lastLine('x'.repeat(500))!;
    expect(long).toHaveLength(MAX_LINE_CHARS);
    expect(long.endsWith('…')).toBe(true);
    expect(Array.from(lastLine('😀'.repeat(400))!)).toHaveLength(MAX_LINE_CHARS);
  });

  it('lastAssistantText accepts string content, skips a partial first line, and handles no text', async () => {
    const path = join(home, 't.jsonl');
    await writeFile(path, `ial":"line"}\n${JSON.stringify(assistant('plain string reply'))}\n`);
    expect(await lastAssistantText(path)).toBe('plain string reply');
    await writeFile(path, `${JSON.stringify(assistant([{ type: 'tool_use' }]))}\n`);
    expect(await lastAssistantText(path)).toBeUndefined();
  });

  it('prefers last_assistant_message from the hook input when present', async () => {
    await startApp();
    expect(await runHook(stop({ last_assistant_message: 'Done.\nMerged.' }))).toBe('posted');
    expect(posted[0].body).toBe('✅ payments agent finished\nMerged.');
  });
});
