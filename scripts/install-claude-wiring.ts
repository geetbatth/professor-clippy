/**
 * Wire Professor Clippy into Claude Code (or remove the wiring).
 *
 *   node scripts/install-claude-wiring.ts install   [--dry-run] [--home <dir>]
 *   node scripts/install-claude-wiring.ts uninstall [--dry-run] [--home <dir>]
 *
 * install:
 *  1. `claude mcp add --scope user clippy -- node <apps/mcp/dist/index.js>` (the CLI
 *     writes that to ~/.claude.json; this script never edits that file itself).
 *  2. Merges `Stop` and `Notification` hooks running `node <apps/hook/dist/index.js>`
 *     into <config dir>/settings.json, keeping everything else (backed up first).
 *  3. Appends the Professor Clippy hint to <config dir>/CLAUDE.md once.
 * uninstall reverses all three. Both are idempotent.
 *
 * Config dir: `<home>/.claude` with `--home <dir>`, else `CLAUDE_CONFIG_DIR`, else
 * `~/.claude`. With `--home`, the `claude` CLI also runs with
 * `CLAUDE_CONFIG_DIR=<home>/.claude` so it can't touch the real user config.
 * Build first (`npm run build`). Runs directly on Node 24 (type stripping); keep
 * this file free of relative imports and non-erasable TypeScript syntax.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_SERVER_NAME = 'clippy';
export const HOOK_EVENTS = ['Stop', 'Notification'] as const;
export const CLAUDE_MD_HINT =
  'When the user asks you to leave a message, remind them, notify them, or check with them, use the Professor Clippy MCP tools (leave_message / remind_me / ask_user).';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_MCP_PATH = join(repoRoot, 'apps', 'mcp', 'dist', 'index.js');
export const DEFAULT_HOOK_PATH = join(repoRoot, 'apps', 'hook', 'dist', 'index.js');

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}
/** Runs the `claude` CLI with `args`; injectable so tests never run the real one. */
export type ClaudeRunner = (args: string[], env: NodeJS.ProcessEnv) => RunResult;

export interface WiringOptions {
  action: 'install' | 'uninstall';
  dryRun?: boolean;
  /** Fake user home: config dir becomes `<home>/.claude`. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  mcpPath?: string;
  hookPath?: string;
  runClaude?: ClaudeRunner;
  log?: (line: string) => void;
  now?: () => Date;
}

/** Forward slashes: safe inside the bash/cmd command strings Claude Code runs, and fine for Node. */
const slashes = (p: string) => resolve(p).replace(/\\/g, '/');

export const hookCommand = (hookPath: string) => `node "${slashes(hookPath)}"`;

/** Our hook entries: the exact command, or any `node ".../apps/hook/dist/index.js"` (e.g. from an older checkout). */
const isOurHook = (command: unknown, wanted: string) =>
  typeof command === 'string' &&
  (command === wanted || /^node\s+"?[^"]*[\\/]apps[\\/]hook[\\/]dist[\\/]index\.js"?\s*$/i.test(command));

export function resolveConfigDir(home: string | undefined, env: NodeJS.ProcessEnv) {
  if (home) {
    const configDir = join(resolve(home), '.claude');
    return { configDir, childEnv: { ...env, CLAUDE_CONFIG_DIR: configDir, HOME: resolve(home), USERPROFILE: resolve(home) } };
  }
  return { configDir: env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), '.claude'), childEnv: env };
}

/** Quote one argument for cmd.exe (only used for the `claude.cmd` fallback). */
const cmdQuote = (arg: string) => (/^[\w\-.:/=@\\]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`);

export const defaultRunner: ClaudeRunner = (args, env) => {
  let r = spawnSync('claude', args, { env, encoding: 'utf8' });
  // npm installs ship claude.cmd, which can only be started through a shell on Windows.
  if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT' && process.platform === 'win32') {
    r = spawnSync(['claude', ...args].map(cmdQuote).join(' '), { env, encoding: 'utf8', shell: true });
  }
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

type HookGroup = { matcher?: string; hooks?: Array<{ type?: string; command?: unknown }> } & Record<string, unknown>;
type SettingsJson = { hooks?: Record<string, HookGroup[]> } & Record<string, unknown>;

/** Settings with our hooks removed from every event (groups, events and `hooks` that this empties are dropped). */
function withoutOurHooks(settings: SettingsJson, wanted: string): SettingsJson {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) {
      hooks[event] = groups;
      continue;
    }
    const kept = groups.flatMap((group) => {
      if (!Array.isArray(group?.hooks)) return [group];
      const rest = group.hooks.filter((h) => !isOurHook(h?.command, wanted));
      if (rest.length === group.hooks.length) return [group];
      return rest.length ? [{ ...group, hooks: rest }] : [];
    });
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept; // drop events we emptied
  }
  const next: SettingsJson = { ...settings, hooks };
  if (Object.keys(hooks).length === 0 && Object.keys(settings.hooks).length > 0) delete next.hooks;
  return next;
}

/** True when each of our events has exactly one hook of ours and it is `wanted`. */
function hasExactlyOurHooks(settings: SettingsJson, wanted: string): boolean {
  return HOOK_EVENTS.every((event) => {
    const commands = (settings.hooks?.[event] ?? []).flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []).map((h) => h?.command));
    const ours = commands.filter((c) => isOurHook(c, wanted));
    return ours.length === 1 && ours[0] === wanted;
  });
}

export function mergeHooks(settings: SettingsJson, hookPath: string): SettingsJson {
  const wanted = hookCommand(hookPath);
  if (hasExactlyOurHooks(settings, wanted)) return settings;
  const next = withoutOurHooks(settings, wanted);
  const hooks = { ...(next.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: 'command', command: wanted }] }];
  }
  return { ...next, hooks };
}

export function removeHooks(settings: SettingsJson, hookPath: string): SettingsJson {
  return withoutOurHooks(settings, hookCommand(hookPath));
}

export function addHint(markdown: string): string {
  if (markdown.split(/\r?\n/).some((line) => line.trim() === CLAUDE_MD_HINT)) return markdown;
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const sep = markdown === '' ? '' : markdown.endsWith('\n') ? eol : eol + eol;
  return markdown + sep + CLAUDE_MD_HINT + eol;
}

export function removeHint(markdown: string): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim() !== CLAUDE_MD_HINT) {
      out.push(line);
      continue;
    }
    if (out.length > 0 && out.at(-1) === '') out.pop(); // the blank separator addHint put before it
  }
  return out.join(eol);
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

function readSettings(path: string): SettingsJson {
  const text = readText(path);
  if (text === undefined || text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // fall through
  }
  throw new Error(`${path} is not a JSON object; fix it by hand and run again (nothing was changed).`);
}

/** Install or uninstall the wiring. Returns the config dir it worked on. */
export function runWiring(options: WiringOptions): { configDir: string } {
  const env = options.env ?? process.env;
  const log = options.log ?? ((line: string) => console.log(line));
  const runClaude = options.runClaude ?? defaultRunner;
  const now = options.now ?? (() => new Date());
  const dry = options.dryRun ?? false;
  const mcpPath = resolve(options.mcpPath ?? DEFAULT_MCP_PATH);
  const hookPath = resolve(options.hookPath ?? DEFAULT_HOOK_PATH);
  const { configDir, childEnv } = resolveConfigDir(options.home, env);
  const settingsPath = join(configDir, 'settings.json');
  const claudeMdPath = join(configDir, 'CLAUDE.md');
  const prefix = dry ? '[dry-run] would ' : '';
  const install = options.action === 'install';

  log(`${install ? 'Installing' : 'Uninstalling'} Professor Clippy wiring (Claude config dir: ${configDir})`);

  if (install && !dry) {
    for (const built of [mcpPath, hookPath]) {
      if (!existsSync(built)) throw new Error(`${built} not found; run \`npm run build\` first.`);
    }
  }

  // 1. MCP server, through the CLI (it owns ~/.claude.json).
  const claude = (args: string[]) => {
    log(`${prefix}run: claude ${args.map(cmdQuote).join(' ')}`);
    return dry ? undefined : runClaude(args, childEnv);
  };
  const removed = claude(['mcp', 'remove', '--scope', 'user', MCP_SERVER_NAME]);
  if (removed?.error) throw new Error(`Could not run the Claude Code CLI (\`claude\`): ${removed.error.message}`);
  if (removed && removed.status !== 0) log(`  (no existing "${MCP_SERVER_NAME}" MCP server to remove)`);
  if (install) {
    const added = claude(['mcp', 'add', '--scope', 'user', MCP_SERVER_NAME, '--', 'node', slashes(mcpPath)]);
    if (added && (added.error || added.status !== 0)) {
      throw new Error(`claude mcp add failed: ${(added.stderr || added.stdout || added.error?.message || '').trim()}`);
    }
  }

  // 2. Hooks in settings.json.
  const before = readSettings(settingsPath);
  const after = install ? mergeHooks(before, hookPath) : removeHooks(before, hookPath);
  if (JSON.stringify(after) === JSON.stringify(before)) {
    log(`settings.json: ${install ? 'hooks already installed' : 'no Professor Clippy hooks'}`);
  } else {
    log(`${prefix}${install ? 'add' : 'remove'} Stop + Notification hooks (${hookCommand(hookPath)}) in ${settingsPath}`);
    if (!dry) {
      mkdirSync(configDir, { recursive: true });
      if (existsSync(settingsPath)) {
        const stem = `${settingsPath}.clippy-backup-${now().toISOString().replace(/[:.]/g, '-')}`;
        let backup = stem;
        for (let n = 1; existsSync(backup); n++) backup = `${stem}-${n}`; // never overwrite an earlier backup
        copyFileSync(settingsPath, backup);
        log(`  backed up to ${backup}`);
      }
      writeFileSync(settingsPath, `${JSON.stringify(after, null, 2)}\n`);
    }
  }

  // 3. CLAUDE.md hint.
  const md = readText(claudeMdPath);
  const nextMd = install ? addHint(md ?? '') : md === undefined ? undefined : removeHint(md);
  if (nextMd === undefined || nextMd === md) {
    log(`CLAUDE.md: ${install ? 'hint already present' : 'no hint to remove'}`);
  } else {
    log(`${prefix}${install ? 'append' : 'remove'} the Professor Clippy hint in ${claudeMdPath}`);
    if (!dry) {
      mkdirSync(configDir, { recursive: true });
      writeFileSync(claudeMdPath, nextMd);
    }
  }

  log(dry ? 'Dry run: nothing changed.' : 'Done.');
  return { configDir };
}

const USAGE = 'Usage: node scripts/install-claude-wiring.ts <install|uninstall> [--dry-run] [--home <dir>]';

export function parseArgs(argv: string[]): Pick<WiringOptions, 'action' | 'dryRun' | 'home'> {
  let action: WiringOptions['action'] | undefined;
  let dryRun = false;
  let home: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === 'install' || arg === 'uninstall') action = arg;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--home' && argv[i + 1]) home = argv[++i];
    else if (arg?.startsWith('--home=')) home = arg.slice('--home='.length);
    else throw new Error(`Unknown argument: ${arg}\n${USAGE}`);
  }
  if (!action) {
    if (!dryRun) throw new Error(USAGE);
    action = 'install'; // bare --dry-run previews an install
  }
  return { action, dryRun, home };
}

if (import.meta.main) {
  try {
    runWiring(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
