/**
 * Clippy's brain: one headless Claude Code turn at a time (`claude -p`), resuming one shared
 * session for the desk chat and WhatsApp (decision 19).
 *
 * - Turns are queued and run strictly one after another.
 * - Streamed text goes out as `chat:delta`; the finished reply is stored as a
 *   `kind:'chat', role:'clippy'` Message and sent as `chat:done`. Failures send
 *   `chat:done {error}` with a message a person can act on.
 * - `brain:state` is `thinking` while any turn is queued or running, else `idle`.
 * - The session id from the stream is kept in `kv` (`brainSessionId`) and passed back with
 *   `--resume`. `newChat()` forgets it; a turn already running then can't bring it back.
 */
import { homedir } from 'node:os';
import type { ChatDone, ClippyEvent, ClippyEventMap, Message } from '@clippy/shared';
import type { Store } from '../core/store';
import { PERSONA, WHATSAPP_PREFIX } from './persona';
import { createSpawnRunner, type ClaudeRunner, type ClaudeRunResult } from './runner';
import { StreamJsonParser } from './streamParser';

export const SESSION_KV_KEY = 'brainSessionId';
/**
 * The clippy MCP tools the brain may use. Not `ask_user` or `check_reply`: `ask_user` blocks
 * until the user answers, and a brain turn waiting for an answer would stall every turn
 * queued behind it (the user's answer would itself be a queued turn). The brain asks in its
 * reply text instead (see the persona).
 */
export const BRAIN_CLIPPY_TOOLS = [
  'leave_message',
  'remind_me',
  'list_reminders',
  'cancel_reminder',
  'list_pending_asks',
  'answer_pending',
] as const;
/** clippy MCP tools the brain must never see (removed from its context, not just denied). */
export const BRAIN_BLOCKED_CLIPPY_TOOLS = ['ask_user', 'check_reply'] as const;
const mcp = (tools: readonly string[]) => tools.map((t) => `mcp__clippy__${t}`);
/** Allowed tools (the CLI accepts space-separated lists). */
export const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', ...mcp(BRAIN_CLIPPY_TOOLS)].join(' ');
export const DISALLOWED_TOOLS = ['Edit', 'Write', 'Bash', 'NotebookEdit', ...mcp(BRAIN_BLOCKED_CLIPPY_TOOLS)].join(' ');
/** Built-in tools that exist at all for the brain (so PowerShell, Agent etc. aren't even offered). */
export const BUILTIN_TOOLS = 'Read,Glob,Grep,WebSearch,WebFetch';
/** A turn that runs longer than this is killed. */
export const DEFAULT_TURN_TIMEOUT_MS = 5 * 60 * 1000;

export const BRAIN_ERRORS = {
  missing:
    "I can't find Claude Code (the `claude` command). Install it from https://claude.com/claude-code, make sure `claude` works in a terminal, then try again.",
  notLoggedIn: "Claude Code isn't logged in. Open a terminal, run `claude`, log in, then try again.",
  timeout: 'That took far too long, even for a professor. I gave up on it; please try again.',
} as const;

export type Channel = 'desk' | 'whatsapp';

export interface BrainReply {
  /** The stored reply (absent on error). */
  message?: Message;
  error?: string;
}

export interface BrainOptions {
  store: Store;
  /** Push an event to the renderer (no-op if there is no window). */
  emit: <E extends ClippyEvent>(event: E, payload: ClippyEventMap[E]) => void;
  runner?: ClaudeRunner;
  /** `--mcp-config` file; undefined runs without the clippy tools. */
  mcpConfigPath?: string | undefined;
  /** `--settings` file (disables hooks for brain turns). */
  settingsPath?: string | undefined;
  /** Working directory for the CLI; default the user's home. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  turnTimeoutMs?: number;
  /** Extra CLI arguments (manual smoke tests, e.g. `--max-turns 1`). */
  extraArgs?: string[];
  log?: (message: string, err?: unknown) => void;
}

interface Turn {
  text: string;
  channel: Channel;
  resolve(reply: BrainReply): void;
}

export class Brain {
  readonly #opts: BrainOptions;
  readonly #runner: ClaudeRunner;
  readonly #queue: Turn[] = [];
  #running = false;
  #disposed = false;
  /** Bumped by `newChat()`; a turn started under an older generation doesn't store its session. */
  #generation = 0;
  #current: { kill(): void } | undefined;

  constructor(options: BrainOptions) {
    this.#opts = options;
    this.#runner = options.runner ?? createSpawnRunner();
  }

  /** Queue a turn. Resolves with the stored reply or an error once that turn has finished. */
  ask(text: string, opts: { channel?: Channel } = {}): Promise<BrainReply> {
    if (this.#disposed) return Promise.resolve({ error: 'Clippy is shutting down.' });
    return new Promise((resolve) => {
      this.#queue.push({ text, channel: opts.channel ?? 'desk', resolve });
      if (this.#queue.length === 1 && !this.#running) this.#opts.emit('brain:state', 'thinking');
      void this.#pump();
    });
  }

  /** Forget the resumed session; the next turn starts a fresh conversation. */
  newChat(): void {
    this.#generation++;
    this.#opts.store.deleteKv(SESSION_KV_KEY);
  }

  get busy(): boolean {
    return this.#running || this.#queue.length > 0;
  }

  /**
   * Fail the queued turns and kill the running one (which then finishes through the normal
   * path with a "shutting down" error, so it is resolved exactly once).
   */
  dispose(): void {
    this.#disposed = true;
    const waiting = this.#queue.splice(this.#running ? 1 : 0);
    for (const turn of waiting) turn.resolve({ error: 'Clippy is shutting down.' });
    this.#current?.kill();
  }

  /** CLI arguments for a turn (the prompt itself goes to stdin). */
  buildArgs(sessionId: string | undefined): string[] {
    const o = this.#opts;
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      ...(sessionId ? ['--resume', sessionId] : []),
      '--append-system-prompt',
      PERSONA,
      ...(o.mcpConfigPath ? ['--mcp-config', o.mcpConfigPath] : []),
      '--strict-mcp-config',
      '--allowedTools',
      ALLOWED_TOOLS,
      '--disallowedTools',
      DISALLOWED_TOOLS,
      '--tools',
      BUILTIN_TOOLS,
      '--permission-mode',
      'dontAsk',
      ...(o.settingsPath ? ['--settings', o.settingsPath] : []),
      ...(o.extraArgs ?? []),
    ];
  }

  async #pump(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      for (let turn = this.#queue[0]; turn; turn = this.#queue[0]) {
        let reply: BrainReply;
        try {
          reply = await this.#turn(turn);
        } catch (err) {
          this.#log('brain turn failed', err);
          reply = { error: `My brain hiccuped: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (this.#queue[0] === turn) this.#queue.shift();
        const done: ChatDone = reply.message ? { message: reply.message } : { error: reply.error ?? 'Unknown error' };
        this.#opts.emit('chat:done', done);
        turn.resolve(reply);
      }
    } finally {
      this.#running = false;
      this.#opts.emit('brain:state', 'idle');
    }
  }

  async #turn(turn: Turn): Promise<BrainReply> {
    const generation = this.#generation;
    const prompt = turn.channel === 'whatsapp' ? WHATSAPP_PREFIX + turn.text : turn.text;
    const sessionId = this.#opts.store.getKv(SESSION_KV_KEY);
    let outcome = await this.#run(prompt, sessionId);
    // A resumed session that no longer exists (deleted, or another machine): start afresh once.
    if (sessionId && outcome.resumeMissing) {
      this.#log(`brain session ${sessionId} not found; starting a new one`);
      if (generation === this.#generation) this.#opts.store.deleteKv(SESSION_KV_KEY);
      outcome = await this.#run(prompt, undefined);
    }
    if (outcome.sessionId && generation === this.#generation) this.#opts.store.setKv(SESSION_KV_KEY, outcome.sessionId);
    if (outcome.error !== undefined) return { error: outcome.error };
    const message = this.#opts.store.createMessage({
      kind: 'chat',
      role: 'clippy',
      sender: 'clippy',
      body: outcome.reply,
      state: 'done',
    });
    return { message };
  }

  async #run(
    prompt: string,
    sessionId: string | undefined,
  ): Promise<{ reply: string; sessionId?: string; error?: string; resumeMissing?: boolean }> {
    if (this.#disposed) return { reply: '', error: 'Clippy is shutting down.' };
    const parser = new StreamJsonParser((event) => {
      if (event.type === 'text') this.#opts.emit('chat:delta', { text: event.text });
    });
    const env: NodeJS.ProcessEnv = { ...(this.#opts.env ?? process.env), CLIPPY_BRAIN: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const run = this.#runner(
      { args: this.buildArgs(sessionId), stdin: prompt, cwd: this.#opts.cwd ?? homedir(), env },
      (chunk) => parser.push(chunk),
    );
    this.#current = run;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      run.kill();
    }, this.#opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    let result: ClaudeRunResult;
    try {
      result = await run.done;
    } finally {
      clearTimeout(timer);
      this.#current = undefined;
    }
    parser.end();

    const sid = parser.sessionId;
    const withSession = <T extends object>(o: T) => (sid ? { ...o, sessionId: sid } : o);
    if (result.spawnError) {
      if (result.spawnError.code === 'ENOENT') return { reply: '', error: BRAIN_ERRORS.missing };
      return { reply: '', error: `I couldn't start Claude Code: ${result.spawnError.message}` };
    }
    if (timedOut) return withSession({ reply: '', error: BRAIN_ERRORS.timeout });
    const final = parser.result;
    const failureText = [final?.text, ...(final?.errors ?? []), result.stderr].filter(Boolean).join('\n');
    if (final?.ok) {
      const reply = parser.reply.trim() || final.text?.trim() || '';
      return withSession({ reply: reply || '…' });
    }
    if (/No conversation found/i.test(failureText)) return { reply: '', resumeMissing: true };
    if (parser.authFailed || /not logged in|please run \/login|invalid api key|authentication/i.test(failureText)) {
      return withSession({ reply: '', error: BRAIN_ERRORS.notLoggedIn });
    }
    if (this.#disposed) return { reply: '', error: 'Clippy is shutting down.' };
    const detail = (final?.errors[0] ?? final?.text ?? lastLine(result.stderr) ?? `claude exited with code ${result.code}`).trim();
    return withSession({ reply: '', error: `My brain hiccuped: ${detail || `claude exited with code ${result.code}`}` });
  }

  #log(message: string, err?: unknown): void {
    if (this.#opts.log) this.#opts.log(message, err);
    else if (err === undefined) console.warn(`[clippy] ${message}`);
    else console.warn(`[clippy] ${message}:`, err);
  }
}

function lastLine(text: string): string | undefined {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop();
}
