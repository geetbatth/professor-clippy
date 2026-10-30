/**
 * Finding and restarting an app by its exe name, on top of a {@link PowerExecutor}.
 *
 * A restart terminates every process of that exe, waits {@link RELAUNCH_WAIT_MS}, and, unless
 * the app has already started itself again (Explorer does), relaunches the root instance (the
 * one whose parent is not another match) with its own path and the rest of its command line.
 * Windows' own processes and Clippy's process tree are refused, and so is an app Windows won't
 * show the path of (elevated or system), since it could not be started again.
 */
import { basename } from 'node:path';
import { AppName } from '@clippy/shared';
import { ForbiddenError, NotFoundError, ValidationError } from '../core/errors';
import type { PowerExecutor, ProcessInfo } from './executor';

/** How long a terminated app gets to come back by itself before Clippy relaunches it. */
export const RELAUNCH_WAIT_MS = 1500;

/** Windows processes that must never be terminated (names without `.exe`, lower case). */
export const CRITICAL_PROCESSES: ReadonlySet<string> = new Set([
  'system',
  'idle',
  'registry',
  'smss',
  'csrss',
  'wininit',
  'winlogon',
  'services',
  'lsass',
  'svchost',
  'dwm',
  'fontdrvhost',
  'memory compression',
]);

/** A running app, ready to be restarted. */
export interface AppTarget {
  /** Exe name, e.g. `chrome.exe`. */
  exe: string;
  /** What to call it: its file description or window title, else the exe name. */
  label: string;
  processes: ProcessInfo[];
  /** The instance that gets relaunched. */
  root: ProcessInfo & { executablePath: string };
}

/** `chrome` or `Chrome.EXE` → `chrome.exe` (case kept). Throws ValidationError for a name that isn't one. */
export function toExeName(raw: string): string {
  const parsed = AppName.safeParse(raw);
  if (!parsed.success) throw new ValidationError(`${JSON.stringify(raw)} is not a program name; use the exe name, e.g. chrome or notepad.exe`);
  return /\.exe$/i.test(parsed.data) ? parsed.data : `${parsed.data}.exe`;
}

/** Is this one of Windows' own critical processes? */
export function isCritical(exe: string): boolean {
  return CRITICAL_PROCESSES.has(exe.replace(/\.exe$/i, '').toLowerCase());
}

/**
 * The arguments after argv0 in a Windows command line, verbatim: argv0 is either a quoted string
 * (up to the next quote) or runs to the first space or tab, the way Windows itself splits it.
 */
export function commandLineArgs(commandLine: string | null): string {
  if (!commandLine) return '';
  const text = commandLine.trimStart();
  let end: number;
  if (text.startsWith('"')) {
    const close = text.indexOf('"', 1);
    end = close === -1 ? text.length : close + 1;
  } else {
    const space = text.search(/[ \t]/);
    end = space === -1 ? text.length : space;
  }
  return text.slice(end).trim();
}

/** The instance to relaunch: a match whose parent is not another match (the first such, if several). */
export function rootProcess(processes: ProcessInfo[]): ProcessInfo | undefined {
  const pids = new Set(processes.map((p) => p.pid));
  return processes.find((p) => !pids.has(p.parentPid)) ?? processes[0];
}

function labelFor(exe: string, processes: ProcessInfo[], root: ProcessInfo | undefined): string {
  const description = root?.description ?? processes.find((p) => p.description)?.description;
  const title = root?.windowTitle ?? processes.find((p) => p.windowTitle)?.windowTitle;
  return description?.trim() || title?.trim() || exe;
}

const samePath = (a: string | null, b: string) => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * Look an app up and check it may be restarted. Throws ValidationError (not a name),
 * ForbiddenError (Windows' own, Clippy's own, or no path to start it again from) or
 * NotFoundError (not running).
 */
export async function findApp(executor: PowerExecutor, rawName: string): Promise<AppTarget> {
  const exe = toExeName(rawName);
  if (isCritical(exe)) throw new ForbiddenError(`${exe} is part of Windows itself, so I will not restart it.`);
  const { self } = executor;
  if (exe.toLowerCase() === basename(self.exePath).toLowerCase()) {
    throw new ForbiddenError(`${exe} is me (Professor Clippy); I cannot restart myself. Quit me from the tray and start me again.`);
  }
  const processes = await executor.findProcesses(exe);
  if (processes.length === 0) throw new NotFoundError(`No running app called ${rawName.trim()}`);
  if (processes.some((p) => p.pid === self.pid || p.parentPid === self.pid || samePath(p.executablePath, self.exePath))) {
    throw new ForbiddenError(`${exe} belongs to me (Professor Clippy), so I will not restart it.`);
  }
  const root = rootProcess(processes);
  const label = labelFor(exe, processes, root);
  if (!root?.executablePath) {
    throw new ForbiddenError(`${label} runs as administrator or as part of Windows, so I cannot restart it (Windows will not tell me where it lives).`);
  }
  return { exe, label, processes, root: { ...root, executablePath: root.executablePath } };
}

export interface RestartOutcome {
  label: string;
  /** False when the app started itself again before Clippy relaunched it (Explorer does). */
  relaunched: boolean;
}

/** Terminate every process of `exe` and start it again. Throws an Error a person can read when it can't. */
export async function restartApp(executor: PowerExecutor, exe: string): Promise<RestartOutcome> {
  // Looked up afresh: the pids may have changed since the user was asked.
  const target = await findApp(executor, exe);
  const original = new Set(target.processes.map((p) => p.pid));
  let refused = 0;
  for (const p of target.processes) {
    try {
      executor.kill(p.pid);
    } catch (err) {
      // ESRCH: gone already (children often go with their parent).
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') refused++;
    }
  }
  if (refused === target.processes.length) throw new Error(`Windows would not let me close ${target.label}.`);

  await executor.sleep(RELAUNCH_WAIT_MS);
  const after = await executor.findProcesses(target.exe);
  if (after.some((p) => !original.has(p.pid))) return { label: target.label, relaunched: false };
  if (after.length > 0) throw new Error(`${after.length} of its processes would not close, so I did not start it again.`);
  await executor.launch(target.root.executablePath, commandLineArgs(target.root.commandLine));
  return { label: target.label, relaunched: true };
}
