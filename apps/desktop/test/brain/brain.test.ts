import { readFileSync } from 'node:fs';
import { Message, type ClippyEvent } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_TOOLS,
  Brain,
  BRAIN_BLOCKED_CLIPPY_TOOLS,
  BRAIN_CLIPPY_TOOLS,
  BRAIN_ERRORS,
  DISALLOWED_TOOLS,
  SESSION_KV_KEY,
  nowLine,
  type BrainOptions,
} from '../../src/main/brain/brain';
import { PERSONA } from '../../src/main/brain/persona';
import { Store } from '../../src/main/core/store';
import { fakeRunner, fixture, type ScriptedRun } from './fixtures';

const PONG_SESSION = '27cd1719-270d-4ff7-b798-5c362f340594';
const TOOL_SESSION = '5b0c3a52-8f8e-4d7a-9a51-2f3c1e0d9a11';

/** Fixed clock for every brain in these tests. */
const NOW = new Date(2026, 9, 30, 14, 5).getTime(); // 30 Oct 2026, 14:05 local
const NOW_LINE = nowLine(NOW);

describe('Brain', () => {
  let store: Store;
  let events: [ClippyEvent, unknown][];

  beforeEach(() => {
    store = new Store({ path: ':memory:' });
    events = [];
  });
  afterEach(() => store.close());

  function brain(script: ScriptedRun[], extra: Partial<BrainOptions> = {}) {
    const fake = fakeRunner(script);
    const b = new Brain({
      store,
      emit: (event, payload) => events.push([event, payload]),
      runner: fake.runner,
      mcpConfigPath: 'C:/data/brain/brain-mcp.json',
      settingsPath: 'C:/data/brain/brain-settings.json',
      cwd: 'C:/Users/someone',
      env: { PATH: 'x', ELECTRON_RUN_AS_NODE: '1' },
      log: () => {},
      now: () => NOW,
      ...extra,
    });
    return { b, fake };
  }
  const of = (name: ClippyEvent) => events.filter(([e]) => e === name).map(([, p]) => p);

  it('never offers the brain the blocking ask_user / check_reply tools, and covers every other clippy tool', () => {
    const allowed = ALLOWED_TOOLS.split(' ');
    const disallowed = DISALLOWED_TOOLS.split(' ');
    expect(allowed).not.toContain('mcp__clippy__*');
    for (const t of ['ask_user', 'check_reply']) {
      expect(allowed).not.toContain(`mcp__clippy__${t}`);
      expect(disallowed).toContain(`mcp__clippy__${t}`);
    }
    // Every tool the MCP server registers is either offered or blocked, so a new one is a decision.
    const server = readFileSync(new URL('../../../mcp/src/server.ts', import.meta.url), 'utf8');
    const registered = [...server.matchAll(/registerTool\(\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThanOrEqual(8);
    expect([...BRAIN_CLIPPY_TOOLS, ...BRAIN_BLOCKED_CLIPPY_TOOLS].sort()).toEqual([...registered].sort());
    // The persona asks in the reply, never through a tool that waits.
    expect(PERSONA).toMatch(/ask in your reply/);
    // ...and knows what to do with the note tools.
    expect(PERSONA).toMatch(/snooze_note/);
    expect(PERSONA).toMatch(/recent_activity/);
    expect(PERSONA).toMatch(/list_notes with list_pending_asks/);
    expect(PERSONA).toMatch(/add_standing_order phrased as When an agent asks about X, answer: Y/);
    expect(PERSONA).toMatch(/watch_for/);
    expect(PERSONA).toMatch(/finished for when X finishes, any for when I hear from X/);
    expect(PERSONA).toMatch(/look it up with recent_activity/);
    expect(PERSONA).not.toMatch(/"|%/); // survives the cmd.exe fallback
  });

  it('runs claude with the brief flags, the prompt on stdin, cwd = home, and streams the reply', async () => {
    const { b, fake } = brain([{ stdout: fixture('tool-turn') }]);
    const reply = await b.ask('What reminders do I have?');

    const call = fake.calls[0]!;
    expect(call.stdin).toBe(`${NOW_LINE}
What reminders do I have?`);
    expect(call.cwd).toBe('C:/Users/someone');
    expect(call.env.CLIPPY_BRAIN).toBe('1');
    expect(call.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    const args = call.args;
    const flag = (name: string) => args[args.indexOf(name) + 1];
    expect(args[0]).toBe('-p');
    expect(flag('--output-format')).toBe('stream-json');
    expect(args).toContain('--verbose');
    expect(args).toContain('--include-partial-messages');
    expect(args).not.toContain('--resume'); // no session yet
    expect(flag('--append-system-prompt')).toBe(PERSONA);
    expect(flag('--mcp-config')).toBe('C:/data/brain/brain-mcp.json');
    expect(flag('--allowedTools')).toBe(
      'Read Glob Grep WebSearch mcp__clippy__leave_message mcp__clippy__remind_me mcp__clippy__list_reminders ' +
        'mcp__clippy__cancel_reminder mcp__clippy__list_pending_asks mcp__clippy__answer_pending ' +
        'mcp__clippy__list_notes mcp__clippy__recent_activity mcp__clippy__snooze_note mcp__clippy__dismiss_note ' +
        'mcp__clippy__add_standing_order mcp__clippy__list_standing_orders mcp__clippy__cancel_standing_order ' +
        'mcp__clippy__watch_for mcp__clippy__list_watches mcp__clippy__cancel_watch',
    );
    expect(flag('--allowedTools')).toBe(ALLOWED_TOOLS);
    expect(flag('--disallowedTools')).toBe('Edit Write Bash NotebookEdit WebFetch mcp__clippy__ask_user mcp__clippy__check_reply');
    expect(flag('--disallowedTools')).toBe(DISALLOWED_TOOLS);
    expect(flag('--tools')).toBe('Read,Glob,Grep,WebSearch');
    expect(flag('--permission-mode')).toBe('dontAsk');
    expect(flag('--settings')).toBe('C:/data/brain/brain-settings.json');
    expect(args).toContain('--strict-mcp-config');

    expect(of('chat:delta').map((d) => (d as { text: string }).text).join('')).toBe(
      'Let me consult my ledger.\n\nOne reminder: stretch at 9 tomorrow.',
    );
    expect(reply.message).toMatchObject({
      kind: 'chat',
      role: 'clippy',
      sender: 'clippy',
      state: 'done',
      body: 'Let me consult my ledger.\n\nOne reminder: stretch at 9 tomorrow.',
    });
    expect(Message.parse(reply.message)).toEqual(reply.message);
    expect(of('chat:done')).toEqual([{ message: reply.message }]);
    expect(of('brain:state')).toEqual(['thinking', 'idle']);
    expect(store.getKv(SESSION_KV_KEY)).toBe(TOOL_SESSION);
  });

  it('resumes the stored session on the next turn and prefixes WhatsApp turns', async () => {
    const { b, fake } = brain([{ stdout: fixture('pong') }, { stdout: fixture('pong') }]);
    await b.ask('first');
    await b.ask('from my phone', { channel: 'whatsapp' });
    const second = fake.calls[1]!;
    expect(second.args[second.args.indexOf('--resume') + 1]).toBe(PONG_SESSION);
    expect(second.stdin).toBe(`${NOW_LINE}
[via WhatsApp] from my phone`);
  });

  it('starts every prompt with the local time and UTC offset, before the channel tag', async () => {
    const { b, fake } = brain([{ stdout: fixture('pong') }]);
    await b.ask('not now', { channel: 'whatsapp' });
    // Rebuilt from Date's own parts, so the expectation holds in any time zone.
    const d = new Date(NOW);
    const off = -d.getTimezoneOffset();
    const hh = String(Math.floor(Math.abs(off) / 60)).padStart(2, '0');
    const mm = String(Math.abs(off) % 60).padStart(2, '0');
    const expected = `[Now: Fri 2026-10-30 14:05, UTC${off < 0 ? '-' : '+'}${hh}:${mm}]`;
    expect(fake.calls[0]!.stdin).toBe(`${expected}
[via WhatsApp] not now`);
    expect(PERSONA).toMatch(/starts with a \[Now: \.\.\.\] line/);
  });

  it('prefixes Telegram turns, and the persona covers both phone channels without double quotes', async () => {
    const { b, fake } = brain([{ stdout: fixture('pong') }]);
    await b.ask('from my phone', { channel: 'telegram' });
    expect(fake.calls[0]!.stdin).toBe(`${NOW_LINE}
[via Telegram] from my phone`);
    expect(PERSONA).toMatch(/\[via WhatsApp\] or \[via Telegram\]/);
    expect(PERSONA).toMatch(/on the phone \(WhatsApp\/Telegram\)/);
    expect(PERSONA).not.toMatch(/"|%/);
  });

  it('runs turns strictly one at a time, in order', async () => {
    const { b, fake } = brain([{ stdout: fixture('pong'), hold: true }, { stdout: fixture('no-partials') }]);
    const first = b.ask('one');
    const second = b.ask('two');
    await new Promise((r) => setTimeout(r, 10));
    expect(fake.calls.map((c) => c.stdin)).toEqual([`${NOW_LINE}
one`]); // two waits for one
    expect(b.busy).toBe(true);
    fake.release();
    const [r1, r2] = await Promise.all([first, second]);
    expect(fake.calls.map((c) => c.stdin)).toEqual([`${NOW_LINE}
one`, `${NOW_LINE}
two`]);
    expect(r1.message?.body).toBe('pong');
    expect(r2.message?.body).toBe('Ahem.\n\nYou have no reminders.');
    // One thinking..idle span for the whole queue.
    expect(of('brain:state')).toEqual(['thinking', 'idle']);
    expect(of('chat:done')).toHaveLength(2);
    expect(b.busy).toBe(false);
  });

  it('newChat() drops the session, and a turn that was already running cannot restore it', async () => {
    store.setKv(SESSION_KV_KEY, 'old-session');
    const { b, fake } = brain([{ stdout: fixture('pong'), hold: true }, { stdout: fixture('pong') }]);
    const running = b.ask('one');
    await new Promise((r) => setTimeout(r, 10));
    b.newChat();
    expect(store.getKv(SESSION_KV_KEY)).toBeUndefined();
    fake.release();
    await running;
    expect(store.getKv(SESSION_KV_KEY)).toBeUndefined();
    await b.ask('two');
    expect(fake.calls[1]!.args).not.toContain('--resume');
    expect(store.getKv(SESSION_KV_KEY)).toBe(PONG_SESSION);
  });

  it('a vanished session is forgotten and the turn is retried once without --resume', async () => {
    store.setKv(SESSION_KV_KEY, '11111111-2222-3333-4444-555555555555');
    const { b, fake } = brain([
      { stdout: fixture('resume-missing'), result: { code: 1, stderr: 'No conversation found with session ID: 1111…' } },
      { stdout: fixture('pong') },
    ]);
    const reply = await b.ask('hello again');
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]!.args).toContain('--resume');
    expect(fake.calls[1]!.args).not.toContain('--resume');
    expect(reply.message?.body).toBe('pong');
    expect(store.getKv(SESSION_KV_KEY)).toBe(PONG_SESSION);
  });

  it('explains a missing claude CLI', async () => {
    const err = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    const { b } = brain([{ result: { code: null, spawnError: err } }]);
    const reply = await b.ask('hi');
    expect(reply).toEqual({ error: BRAIN_ERRORS.missing });
    expect(of('chat:done')).toEqual([{ error: BRAIN_ERRORS.missing }]);
    expect(of('brain:state')).toEqual(['thinking', 'idle']);
    expect(store.listMessages({ kind: 'chat' })).toEqual([]);
  });

  it('explains a logged-out Claude Code (recorded output) and stores no reply', async () => {
    const { b } = brain([{ stdout: fixture('not-logged-in'), result: { code: 1 } }]);
    const reply = await b.ask('hi');
    expect(reply.error).toBe(BRAIN_ERRORS.notLoggedIn);
    expect(store.listMessages({ kind: 'chat' })).toEqual([]);
  });

  it('reports other failures with the CLI detail', async () => {
    const { b } = brain([{ stdout: '', result: { code: 3, stderr: 'warming up\nAPI Error: 529 overloaded\n' } }]);
    expect((await b.ask('hi')).error).toBe('My brain hiccuped: API Error: 529 overloaded');
  });

  it('kills a turn that runs past the timeout and moves on', async () => {
    const { b, fake } = brain([{ stdout: fixture('pong'), hold: true }, { stdout: fixture('pong') }], { turnTimeoutMs: 20 });
    const slow = b.ask('slow');
    const next = b.ask('next');
    expect((await slow).error).toBe(BRAIN_ERRORS.timeout);
    expect(fake.killed).toBe(1);
    expect((await next).message?.body).toBe('pong');
  });

  it('dispose() kills the running turn and fails queued ones, each settled once', async () => {
    const { b, fake } = brain([{ stdout: fixture('pong'), hold: true }]);
    const running = b.ask('one');
    const queued = b.ask('two');
    await new Promise((r) => setTimeout(r, 10));
    b.dispose();
    expect(fake.killed).toBe(1);
    expect((await queued).error).toMatch(/shutting down/);
    expect((await running).error).toMatch(/shutting down/);
    await new Promise((r) => setTimeout(r, 10));
    expect(of('chat:done')).toEqual([{ error: 'Clippy is shutting down.' }]); // the running turn only
    expect(of('brain:state')).toEqual(['thinking', 'idle']);
    expect(fake.calls).toHaveLength(1); // the queued turn never started
    expect(b.busy).toBe(false);
    expect((await b.ask('three')).error).toMatch(/shutting down/);
  });
});
