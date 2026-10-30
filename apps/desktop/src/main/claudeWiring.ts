/**
 * "Connect Claude Code": runs the Task 4 wiring (`scripts/install-claude-wiring.ts`) for the
 * app's own MCP server and hook. The renderer must preview first (a dry run, shown to the
 * user as the diff) and may install only after that, once the user confirms.
 *
 * - `preview` runs in-process: a dry run only reads files, it never starts the CLI.
 * - `install` runs `claude mcp remove/add`, which takes seconds and is synchronous in the
 *   script, so it runs off the main thread (a utility process in the app; see `wiringChild.ts`).
 *
 * Paths: the packaged app ships the built MCP server and hook as `<resources>/mcp/index.js`
 * and `<resources>/hook/index.js`; a dev build uses `apps/{mcp,hook}/dist/index.js`.
 * `CLIPPY_CLAUDE_HOME=<dir>` points the wiring at `<dir>/.claude` (tests, sandboxes).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { ClaudeWiringReport, ClaudeWiringStep } from '@clippy/shared';
import { HOOK_MARKER, resolveConfigDir, runWiring, type ClaudeRunner } from '../../../../scripts/install-claude-wiring';
import { cmdQuote, type ResolvedCommand } from './brain/runner';

export interface WiringPaths {
  mcpPath: string;
  hookPath: string;
}

export interface WiringLocation {
  /** `process.resourcesPath` when packaged. */
  resourcesPath?: string | undefined;
  /** Directory of the main bundle (`apps/desktop/out/main`). */
  mainDir: string;
  /** `CLIPPY_MCP_PATH`, if set (the same override the brain honours). */
  mcpOverride?: string | undefined;
}

/** Where the MCP server and hook the wiring should register live. */
export function resolveWiringPaths(loc: WiringLocation): WiringPaths {
  if (loc.resourcesPath) {
    return {
      mcpPath: loc.mcpOverride ?? join(loc.resourcesPath, 'mcp', 'index.js'),
      hookPath: join(loc.resourcesPath, 'hook', 'index.js'),
    };
  }
  return {
    mcpPath: loc.mcpOverride ?? resolve(loc.mainDir, '../../../mcp/dist/index.js'),
    hookPath: resolve(loc.mainDir, '../../../hook/dist/index.js'),
  };
}

/** One run of the wiring (always an install; `dryRun` for the preview). Serialisable. */
export interface WiringJob extends WiringPaths {
  dryRun: boolean;
  /** Fake home (`<home>/.claude`); undefined = the user's real Claude config. */
  home?: string | undefined;
}

/** Run the wiring and capture its output; never throws. */
export function runWiringJob(job: WiringJob, deps: { runClaude?: ClaudeRunner | undefined; onLog?: (line: string) => void } = {}): ClaudeWiringReport {
  const log: string[] = [];
  try {
    runWiring({
      action: 'install',
      dryRun: job.dryRun,
      mcpPath: job.mcpPath,
      hookPath: job.hookPath,
      ...(job.home !== undefined && { home: job.home }),
      ...(deps.runClaude && { runClaude: deps.runClaude }),
      log: (line) => {
        log.push(line);
        deps.onLog?.(line);
      },
    });
    return { ok: true, log, warnings: [] };
  } catch (err) {
    return { ok: false, log, error: err instanceof Error ? err.message : String(err), warnings: [] };
  }
}

/**
 * A `claude` runner for the wiring that uses the same lookup as the brain (so it finds the
 * native installer's `~/.local/bin/claude.exe` even when it isn't on PATH) and never flashes
 * a console window. Undefined lets the script use its own `claude`-on-PATH runner.
 */
export function wiringRunner(resolved: ResolvedCommand | undefined): ClaudeRunner | undefined {
  if (!resolved) return undefined;
  return (args, env) => {
    const r = resolved.viaCmd
      ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[resolved.command, ...args].map(cmdQuote).join(' ')}"`], {
          env,
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawnSync(resolved.command, args, { env, encoding: 'utf8', windowsHide: true });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error && { error: r.error }) };
  };
}

export interface ClaudeWiringDeps {
  paths: WiringPaths;
  home?: string | undefined;
  /** `node` on PATH (the registered MCP server and the hook run with it). */
  findNode: () => string | undefined;
  /** The `claude` CLI, if it can be found. */
  findClaude: () => ResolvedCommand | undefined;
  /** Runs a real install off the main thread. */
  runInstall: (job: WiringJob) => Promise<ClaudeWiringReport>;
  /** Defaults to `existsSync`. */
  exists?: (path: string) => boolean;
}

export interface ClaudeWiring {
  connect(step: ClaudeWiringStep): Promise<ClaudeWiringReport>;
}

export function createClaudeWiring(deps: ClaudeWiringDeps): ClaudeWiring {
  const exists = deps.exists ?? existsSync;
  /** A successful preview since the last install started: each install needs its own. */
  let previewed = false;
  let installing: Promise<ClaudeWiringReport> | undefined;

  const job = (dryRun: boolean): WiringJob => ({ ...deps.paths, dryRun, home: deps.home });

  /** Problems the dry run can't see, and an install can't fix. */
  function check(): { warnings: string[]; blocker?: string } {
    const warnings: string[] = [];
    let blocker: string | undefined;
    const missing = [deps.paths.mcpPath, deps.paths.hookPath].filter((p) => !exists(p));
    if (missing.length) blocker = `Missing ${missing.join(' and ')}. Rebuild (npm run build) or reinstall Professor Clippy.`;
    if (!deps.findClaude()) {
      blocker ??= 'Claude Code (the `claude` command) was not found. Install Claude Code, sign in once, then try again.';
    }
    if (!deps.findNode()) {
      warnings.push(
        'Node.js was not found on PATH. Claude Code starts the Clippy MCP server and hook with `node`, so install Node.js 24 (or later) before you use them.',
      );
    }
    return { warnings, ...(blocker !== undefined && { blocker }) };
  }

  return {
    async connect(step) {
      const { warnings, blocker } = check();
      if (step === 'preview') {
        const report = runWiringJob(job(true));
        previewed = report.ok;
        return blocker ? { ...report, ok: false, error: blocker, warnings } : { ...report, warnings };
      }
      // A second click while installing joins the running install.
      if (!installing) {
        if (!previewed) return { ok: false, log: [], error: 'Show the changes first (preview), then install.', warnings };
        if (blocker) return { ok: false, log: [], error: blocker, warnings };
        previewed = false;
        installing = deps.runInstall(job(false)).finally(() => {
          installing = undefined;
        });
      }
      const report = await installing;
      return { ...report, warnings };
    },
  };
}

/**
 * Is Clippy's hook already in Claude Code's settings (Connect Claude Code was run before)? Only a
 * look for the hook's marker in `<config dir>/settings.json`; false if it can't be read. Used to
 * tick Getting started's "Connect Claude Code" for people who connected before the list existed.
 */
export async function claudeHooksInstalled(home?: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  const { configDir } = resolveConfigDir(home, env);
  try {
    return (await readFile(join(configDir, 'settings.json'), 'utf8')).includes(HOOK_MARKER);
  } catch {
    return false;
  }
}
