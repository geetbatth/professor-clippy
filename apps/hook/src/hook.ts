/**
 * Claude Code hook logic: turn a `Stop` or `Notification` hook event into a
 * note on Professor Clippy's sticky note.
 */
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  ClippyClient,
  ClippyNotRunningError,
  DEFAULT_SETTINGS,
  Settings,
  appDataDir,
  settingsPath,
  type NewMessageInput,
} from '@clippy/shared';

/** Sender shown on hook notes. */
export const HOOK_SENDER = 'claude-code';
/** A second `Stop` for the same project within this window is dropped. */
export const STOP_DEDUPE_MS = 60_000;
/** Longest assistant line quoted in a Stop note. */
export const MAX_LINE_CHARS = 300;
/** How much of the transcript's tail is scanned for the last assistant message. */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;
/** Notification types that don't mean "the agent needs you" (Stop already covers the idle prompt). */
const IGNORED_NOTIFICATION_TYPES = new Set(['idle_prompt', 'auth_success']);

export type HookOutcome =
  | 'posted'
  | 'disabled'
  | 'duplicate'
  | 'ignored'
  | 'not-running';

export interface HookDeps {
  now?: () => number;
  connect?: () => Promise<ClippyClient>;
}

/** File (in the app data dir) remembering when each project last got a Stop note. */
export const hookStatePath = () => join(appDataDir(), 'hook-state.json');

interface HookState {
  lastStop: Record<string, number>;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

async function hookEnabled(): Promise<boolean> {
  const parsed = Settings.safeParse((await readJson(settingsPath())) ?? {});
  return (parsed.success ? parsed.data : DEFAULT_SETTINGS).hookEnabled;
}

async function readState(): Promise<HookState> {
  const raw = (await readJson(hookStatePath())) as Partial<HookState> | undefined;
  return { lastStop: raw && typeof raw.lastStop === 'object' && raw.lastStop ? raw.lastStop : {} };
}

async function writeState(state: HookState): Promise<void> {
  const path = hookStatePath();
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state));
  await rename(tmp, path);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n');
}

/** Last non-empty line, trimmed and capped at {@link MAX_LINE_CHARS} (ending in "…" when cut). */
export function lastLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!line) return undefined;
  const chars = Array.from(line); // don't split surrogate pairs
  return chars.length <= MAX_LINE_CHARS ? line : `${chars.slice(0, MAX_LINE_CHARS - 1).join('')}…`;
}

/** Text of the last assistant message with text content in a Claude Code JSONL transcript. */
export async function lastAssistantText(transcriptPath: string): Promise<string | undefined> {
  let raw: string;
  try {
    const file = await open(transcriptPath, 'r');
    try {
      const { size } = await file.stat();
      const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
      const buffer = Buffer.alloc(length);
      await file.read(buffer, 0, length, size - length);
      raw = buffer.toString('utf8');
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
  const lines = raw.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: any;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue; // blank, or the partial first line of the tail
    }
    if (entry?.type !== 'assistant' && entry?.message?.role !== 'assistant') continue;
    const text = textOf(entry?.message?.content).trim();
    if (text) return text;
  }
  return undefined;
}

async function stopNote(input: Record<string, any>, project: string): Promise<NewMessageInput> {
  const text =
    typeof input.last_assistant_message === 'string'
      ? input.last_assistant_message
      : typeof input.transcript_path === 'string'
        ? await lastAssistantText(input.transcript_path)
        : undefined;
  const line = text ? lastLine(text) : undefined;
  return { body: `✅ ${project} agent finished${line ? `\n${line}` : ''}`, sender: HOOK_SENDER, project };
}

/**
 * Handle one hook invocation (`raw` = the JSON Claude Code wrote to stdin).
 * Rejects only on unexpected errors; the CLI wrapper swallows those.
 */
export async function runHook(raw: string, deps: HookDeps = {}): Promise<HookOutcome> {
  const now = deps.now ?? Date.now;
  const connect = deps.connect ?? (() => ClippyClient.fromAppData({ timeoutMs: 2000 }));

  let input: Record<string, any>;
  try {
    input = JSON.parse(raw);
  } catch {
    return 'ignored';
  }
  if (!input || typeof input !== 'object') return 'ignored';
  const event = input.hook_event_name;
  if (event !== 'Stop' && event !== 'Notification') return 'ignored';
  if (!(await hookEnabled())) return 'disabled';

  const project = basename(typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd());
  let note: NewMessageInput;
  let state: HookState | undefined;
  if (event === 'Stop') {
    state = await readState();
    const last = state.lastStop[project];
    if (last !== undefined && now() - last < STOP_DEDUPE_MS) return 'duplicate';
    note = await stopNote(input, project);
  } else {
    if (IGNORED_NOTIFICATION_TYPES.has(input.notification_type)) return 'ignored';
    const message = typeof input.message === 'string' ? input.message.trim() : '';
    if (!message) return 'ignored';
    note = { body: `🔐 ${project}: ${message}`, sender: HOOK_SENDER, project, urgent: true };
  }

  try {
    const client = await connect();
    await client.postMessage(note);
  } catch (error) {
    if (error instanceof ClippyNotRunningError) return 'not-running';
    throw error;
  }

  if (state) {
    state.lastStop[project] = now();
    await writeState(state);
  }
  return 'posted';
}
