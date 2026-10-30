/**
 * Runs the Claude Code CLI for one brain turn. Injectable so tests never start the real CLI.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

export interface ClaudeRunRequest {
  args: string[];
  /** Written to the CLI's stdin, then stdin is closed (the prompt, so it can never be mistaken for a flag). */
  stdin: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ClaudeRunResult {
  /** Exit code (null if killed by a signal). */
  code: number | null;
  /** Last ~8 KB of stderr. */
  stderr: string;
  /** Set when the process could not be started at all (`code` is then null). */
  spawnError?: NodeJS.ErrnoException;
}

export interface ClaudeRun {
  done: Promise<ClaudeRunResult>;
  kill(): void;
}

/** Start the CLI; `onStdout` receives decoded stdout chunks as they arrive. */
export type ClaudeRunner = (request: ClaudeRunRequest, onStdout: (chunk: string) => void) => ClaudeRun;

export interface ResolvedCommand {
  command: string;
  /** npm's `claude.cmd` shim: has to run through `cmd.exe`. */
  viaCmd: boolean;
}

/**
 * Find the `claude` executable: `CLIPPY_CLAUDE_PATH`, then `claude.exe` on PATH, then the
 * native installer's `~/.local/bin/claude.exe`, then an npm `claude.cmd` shim on PATH.
 * Elsewhere than Windows, plain `claude` (resolved by the OS). Undefined if nothing is found.
 */
export function resolveClaude(env: NodeJS.ProcessEnv = process.env, platform = process.platform): ResolvedCommand | undefined {
  if (env.CLIPPY_CLAUDE_PATH) {
    return existsSync(env.CLIPPY_CLAUDE_PATH)
      ? { command: env.CLIPPY_CLAUDE_PATH, viaCmd: /\.(cmd|bat)$/i.test(env.CLIPPY_CLAUDE_PATH) }
      : undefined;
  }
  if (platform !== 'win32') return { command: 'claude', viaCmd: false };
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  const find = (name: string) => dirs.map((d) => join(d, name)).find((p) => existsSync(p));
  const exe = find('claude.exe') ?? [join(env.USERPROFILE ?? homedir(), '.local', 'bin', 'claude.exe')].find(existsSync);
  if (exe) return { command: exe, viaCmd: false };
  const shim = find('claude.cmd');
  return shim ? { command: shim, viaCmd: true } : undefined;
}

/** Quote one argument for `cmd.exe /s /c "..."` (no newlines or `%` in our arguments). */
function cmdQuote(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

const STDERR_KEEP = 8 * 1024;

/** The real runner: spawns the CLI without a shell (or through cmd.exe for an npm shim). */
export function createSpawnRunner(resolve: () => ResolvedCommand | undefined = () => resolveClaude()): ClaudeRunner {
  return (request, onStdout) => {
    const resolved = resolve();
    if (!resolved) {
      const err = Object.assign(new Error('claude not found'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      return { done: Promise.resolve({ code: null, stderr: '', spawnError: err }), kill() {} };
    }
    const child = resolved.viaCmd
      ? spawn(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `"${[resolved.command, ...request.args].map(cmdQuote).join(' ')}"`],
          { cwd: request.cwd, env: request.env, windowsHide: true, windowsVerbatimArguments: true },
        )
      : spawn(resolved.command, request.args, { cwd: request.cwd, env: request.env, windowsHide: true });

    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => onStdout(chunk));
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_KEEP);
    });
    child.stdin.on('error', () => {}); // the CLI may exit before reading stdin
    child.stdin.end(request.stdin, 'utf8');

    const done = new Promise<ClaudeRunResult>((resolveDone) => {
      let spawnError: NodeJS.ErrnoException | undefined;
      child.on('error', (err: NodeJS.ErrnoException) => {
        spawnError = err;
        // 'close' may not follow a failed spawn.
        if (child.pid === undefined) resolveDone({ code: null, stderr, spawnError: err });
      });
      child.on('close', (code) => resolveDone({ code, stderr, ...(spawnError && { spawnError }) }));
    });
    return {
      done,
      kill() {
        if (child.exitCode !== null || child.killed || child.pid === undefined) return;
        if (process.platform === 'win32') {
          // Take the CLI's own children (the MCP server) down with it.
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else {
          child.kill();
        }
      },
    };
  };
}
