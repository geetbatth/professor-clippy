/**
 * Getting a `ClippyClient` for the running desktop app, launching the app if
 * it's installed but not running.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ClippyClient, ClippyNotRunningError } from '@clippy/shared';

/** The tool error agents see when the app can't be reached. */
export const NOT_RUNNING_MESSAGE =
  "Professor Clippy isn't running. Ask the user to start the Professor Clippy desktop app, then try again.";

/** How long to wait for a freshly launched app to answer `/health`. */
export const LAUNCH_WAIT_MS = 15_000;

export interface ConnectOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
  /** Start the app (detached). */
  launch?: (exePath: string) => void;
  /** Max wait after launching, ms. */
  waitMs?: number;
  /** Interval between connection attempts after launching, ms. */
  pollMs?: number;
}

/** Candidate app executables, in order: `CLIPPY_APP_PATH`, then the per-user install location. */
export function appCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  if (env.CLIPPY_APP_PATH) candidates.push(env.CLIPPY_APP_PATH);
  if (env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, 'Programs', 'professor-clippy', 'Professor Clippy.exe'));
  }
  return candidates;
}

function launchDetached(exePath: string): void {
  const child = spawn(exePath, [], { detached: true, stdio: 'ignore' });
  child.on('error', () => {}); // a failed launch shows up as the app never answering
  child.unref();
}

/**
 * Connect to the running app. If it isn't running, launch the first existing
 * candidate executable and retry for up to {@link LAUNCH_WAIT_MS}. Throws
 * `ClippyNotRunningError` when that fails.
 */
export async function connectToClippy(options: ConnectOptions = {}): Promise<ClippyClient> {
  try {
    return await ClippyClient.fromAppData();
  } catch (error) {
    if (!(error instanceof ClippyNotRunningError)) throw error;
  }

  const exists = options.exists ?? existsSync;
  const exe = appCandidates(options.env ?? process.env).find((p) => exists(p));
  if (!exe) throw new ClippyNotRunningError(NOT_RUNNING_MESSAGE);

  (options.launch ?? launchDetached)(exe);
  const deadline = Date.now() + (options.waitMs ?? LAUNCH_WAIT_MS);
  const pollMs = options.pollMs ?? 500;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    try {
      return await ClippyClient.fromAppData();
    } catch (error) {
      if (!(error instanceof ClippyNotRunningError)) throw error;
    }
  }
  throw new ClippyNotRunningError(NOT_RUNNING_MESSAGE);
}
