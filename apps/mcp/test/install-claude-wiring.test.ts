/**
 * Tests for scripts/install-claude-wiring.ts. Everything runs against a temp
 * home with a stubbed `claude` CLI; the real ~/.claude is never touched.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_MD_HINT,
  addHint,
  hookCommand,
  parseArgs,
  removeHint,
  resolveConfigDir,
  runWiring,
  type ClaudeRunner,
  type WiringOptions,
} from '../../../scripts/install-claude-wiring';

const SCRIPT = fileURLToPath(new URL('../../../scripts/install-claude-wiring.ts', import.meta.url));

let home: string;
let configDir: string;
let mcpPath: string;
let hookPath: string;
let calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>;
let servers: Set<string>;

/** Stub of `claude mcp add/remove` that behaves like the real CLI (add fails if the name exists). */
const fakeClaude: ClaudeRunner = (args, env) => {
  calls.push({ args, env });
  const name = args[4]; // mcp <add|remove> --scope user <name>
  if (args[1] === 'add') {
    if (servers.has(name!)) return { status: 1, stdout: '', stderr: `MCP server ${name} already exists in user config` };
    servers.add(name!);
    return { status: 0, stdout: `Added stdio MCP server ${name}`, stderr: '' };
  }
  if (args[1] === 'remove') {
    if (!servers.delete(name!)) return { status: 1, stdout: '', stderr: `No user-scoped MCP server found with name: ${name}` };
    return { status: 0, stdout: `Removed MCP server ${name}`, stderr: '' };
  }
  return { status: 1, stdout: '', stderr: 'unexpected' };
};

const run = (action: WiringOptions['action'], extra: Partial<WiringOptions> = {}) => {
  const lines: string[] = [];
  runWiring({
    action,
    home,
    env: {},
    mcpPath,
    hookPath,
    runClaude: fakeClaude,
    log: (l) => lines.push(l),
    now: () => new Date('2026-10-30T12:00:00.000Z'),
    ...extra,
  });
  return lines;
};

const settingsFile = () => join(configDir, 'settings.json');
const readSettings = () => JSON.parse(readFileSync(settingsFile(), 'utf8'));
const backups = () => readdirSync(configDir).filter((f) => f.startsWith('settings.json.clippy-backup-'));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'clippy-wiring-'));
  configDir = join(home, '.claude');
  mkdirSync(join(home, 'repo', 'apps', 'mcp', 'dist'), { recursive: true });
  mkdirSync(join(home, 'repo', 'apps', 'hook', 'dist'), { recursive: true });
  mcpPath = join(home, 'repo', 'apps', 'mcp', 'dist', 'index.js');
  hookPath = join(home, 'repo', 'apps', 'hook', 'dist', 'index.js');
  writeFileSync(mcpPath, '');
  writeFileSync(hookPath, '');
  calls = [];
  servers = new Set();
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

const userSettings = {
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }],
  },
};
const userMd = '# My rules\n\nBe terse.\n';

describe('install', () => {
  it('registers the MCP server via the CLI, merges hooks and appends the hint', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(userSettings, null, 2));
    writeFileSync(join(configDir, 'CLAUDE.md'), userMd);

    run('install');

    const fwd = (p: string) => p.replace(/\\/g, '/');
    expect(calls.map((c) => c.args)).toEqual([
      ['mcp', 'remove', '--scope', 'user', 'clippy'],
      ['mcp', 'add', '--scope', 'user', 'clippy', '--', 'node', fwd(mcpPath)],
    ]);
    // the CLI is pointed at the temp home, never the real config
    for (const { env } of calls) {
      expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
      expect(env.USERPROFILE).toBe(home);
    }
    expect(servers).toEqual(new Set(['clippy']));

    const ours = { hooks: [{ type: 'command', command: `node "${fwd(hookPath)}" --professor-clippy` }] };
    expect(readSettings()).toEqual({
      ...userSettings,
      hooks: { ...userSettings.hooks, Stop: [...userSettings.hooks.Stop, ours], Notification: [ours] },
    });
    expect(backups()).toEqual(['settings.json.clippy-backup-2026-10-30T12-00-00-000Z']);
    expect(JSON.parse(readFileSync(join(configDir, backups()[0]!), 'utf8'))).toEqual(userSettings);

    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe(`${userMd}\n${CLAUDE_MD_HINT}\n`);
  });

  it('creates settings.json and CLAUDE.md when missing (no backup needed)', () => {
    run('install');
    expect(Object.keys(readSettings().hooks)).toEqual(['Stop', 'Notification']);
    expect(backups()).toEqual([]);
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe(`${CLAUDE_MD_HINT}\n`);
  });

  it('is idempotent: a second install changes no files and makes no new backup', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(userSettings));
    writeFileSync(join(configDir, 'CLAUDE.md'), userMd);
    run('install');
    const settingsAfterFirst = readFileSync(settingsFile(), 'utf8');
    const mdAfterFirst = readFileSync(join(configDir, 'CLAUDE.md'), 'utf8');

    const log = run('install', { now: () => new Date('2026-10-31T00:00:00.000Z') });

    expect(readFileSync(settingsFile(), 'utf8')).toBe(settingsAfterFirst);
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe(mdAfterFirst);
    expect(backups()).toHaveLength(1);
    expect(log).toContain('settings.json: hooks already installed');
    expect(log).toContain('CLAUDE.md: hint already present');
    expect(servers).toEqual(new Set(['clippy'])); // re-registered via remove + add
  });

  it('replaces a stale hook from an older checkout instead of adding a second one', () => {
    mkdirSync(configDir, { recursive: true });
    const stale = { type: 'command', command: 'node "D:/old/professor-clippy/apps/hook/dist/index.js" --professor-clippy' };
    writeFileSync(settingsFile(), JSON.stringify({ hooks: { Stop: [{ hooks: [stale] }], Notification: [{ hooks: [stale] }] } }));
    run('install');
    const { hooks } = readSettings();
    for (const event of ['Stop', 'Notification']) {
      expect(hooks[event]).toEqual([{ hooks: [{ type: 'command', command: hookCommand(hookPath) }] }]);
    }
  });

  it('refuses to overwrite a settings.json that is not valid JSON', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), '{ "model": "opus", }');
    expect(() => run('install')).toThrow(/not a JSON object; fix it by hand and run again. Nothing was changed./);
    expect(calls).toEqual([]); // validated before the CLI ran
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(false);
    expect(readFileSync(settingsFile(), 'utf8')).toBe('{ "model": "opus", }');
  });

  it('fails clearly when the mcp/hook are not built', () => {
    rmSync(mcpPath);
    expect(() => run('install')).toThrow(/run `npm run build` first/);
    expect(calls).toEqual([]);
  });

  it('reports a failing `claude mcp add`', () => {
    const failing: ClaudeRunner = (args) =>
      args[1] === 'add' ? { status: 1, stdout: '', stderr: 'boom' } : { status: 0, stdout: '', stderr: '' };
    expect(() => run('install', { runClaude: failing })).toThrow(
      'claude mcp add failed: boom. settings.json and CLAUDE.md were not changed; fix this and run install again.',
    );
    expect(existsSync(settingsFile())).toBe(false);
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(false);
  });
});

describe('uninstall', () => {
  it('reverses all three and restores the user files', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(userSettings, null, 2));
    writeFileSync(join(configDir, 'CLAUDE.md'), userMd);
    run('install');
    calls = [];

    run('uninstall');

    expect(calls.map((c) => c.args)).toEqual([['mcp', 'remove', '--scope', 'user', 'clippy']]);
    expect(servers.size).toBe(0);
    expect(readSettings()).toEqual(userSettings);
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe(userMd);
    expect(backups()).toHaveLength(2); // one per write
  });

  it('removes the hooks key and empties CLAUDE.md when we created them', () => {
    run('install');
    run('uninstall');
    expect(readSettings()).toEqual({});
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe('');
  });

  it('is a no-op on a home that was never wired', () => {
    const log = run('uninstall');
    expect(existsSync(configDir)).toBe(false);
    expect(log).toContain('settings.json: no Professor Clippy hooks');
    expect(log).toContain('CLAUDE.md: no hint to remove');
  });
});

describe('foreign look-alike hooks (another monorepo with apps/hook/dist/index.js)', () => {
  const foreign = { type: 'command', command: 'node "D:/work/acme-monorepo/apps/hook/dist/index.js"' };
  const withForeign = { hooks: { Stop: [{ hooks: [foreign] }], Notification: [{ matcher: '', hooks: [foreign] }] } };

  it('install keeps it and adds ours alongside', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(withForeign));
    run('install');
    const ours = { hooks: [{ type: 'command', command: hookCommand(hookPath) }] };
    expect(readSettings()).toEqual({
      hooks: { Stop: [...withForeign.hooks.Stop, ours], Notification: [...withForeign.hooks.Notification, ours] },
    });
  });

  it('uninstall leaves it alone', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(withForeign));
    run('install');
    run('uninstall');
    expect(readSettings()).toEqual(withForeign);
  });

  it('uninstall without our hooks does not touch the file', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(withForeign));
    const log = run('uninstall');
    expect(log).toContain('settings.json: no Professor Clippy hooks');
    expect(readFileSync(settingsFile(), 'utf8')).toBe(JSON.stringify(withForeign));
    expect(backups()).toEqual([]);
  });
});

describe('CLAUDE.md line endings', () => {
  const mixed = '# Rules\r\nOne\nTwo\r\n';

  it('uninstall does not rewrite a mixed-EOL CLAUDE.md that has no hint', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, 'CLAUDE.md'), mixed);
    const log = run('uninstall');
    expect(log).toContain('CLAUDE.md: no hint to remove');
    expect(readFileSync(join(configDir, 'CLAUDE.md'), 'utf8')).toBe(mixed);
  });

  it('removing the hint keeps every other byte, mixed EOLs included', () => {
    expect(removeHint(addHint(mixed))).toBe(mixed);
    expect(removeHint(`A\n${CLAUDE_MD_HINT}\r\nB\r\n`)).toBe('A\nB\r\n');
    expect(removeHint(mixed)).toBe(mixed);
  });
});

describe('--dry-run', () => {
  it('changes nothing and runs no CLI', () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsFile(), JSON.stringify(userSettings));
    const log = run('install', { dryRun: true });
    expect(calls).toEqual([]);
    expect(readFileSync(settingsFile(), 'utf8')).toBe(JSON.stringify(userSettings));
    expect(existsSync(join(configDir, 'CLAUDE.md'))).toBe(false);
    expect(backups()).toEqual([]);
    expect(log.filter((l) => l.startsWith('[dry-run] would '))).toHaveLength(4);
  });

  it('runs as a plain Node script (type stripping) without touching anything', () => {
    const r = spawnSync(process.execPath, [SCRIPT, 'uninstall', '--dry-run', '--home', home], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Claude config dir: ${configDir}`);
    expect(r.stdout).toContain('[dry-run] would run: claude mcp remove --scope user clippy');
    expect(existsSync(configDir)).toBe(false);
  });
});

describe('helpers', () => {
  it('resolveConfigDir: --home, then CLAUDE_CONFIG_DIR', () => {
    expect(resolveConfigDir(home, { CLAUDE_CONFIG_DIR: 'X:/ignored' }).configDir).toBe(configDir);
    const viaEnv = resolveConfigDir(undefined, { CLAUDE_CONFIG_DIR: join(home, 'cfg') });
    expect(viaEnv.configDir).toBe(join(home, 'cfg'));
    expect(viaEnv.childEnv).toEqual({ CLAUDE_CONFIG_DIR: join(home, 'cfg') });
  });

  it('parseArgs', () => {
    expect(parseArgs(['install'])).toEqual({ action: 'install', dryRun: false, home: undefined });
    expect(parseArgs(['--dry-run'])).toEqual({ action: 'install', dryRun: true, home: undefined });
    expect(parseArgs(['uninstall', '--home=C:/t'])).toEqual({ action: 'uninstall', dryRun: false, home: 'C:/t' });
    expect(() => parseArgs([])).toThrow(/Usage/);
    expect(() => parseArgs(['instal'])).toThrow(/Unknown argument: instal/);
  });

  it('addHint / removeHint round-trip, CRLF too', () => {
    for (const md of ['', 'a', 'a\n', 'a\r\nb\r\n']) {
      const added = addHint(md);
      expect(addHint(added)).toBe(added);
      expect(removeHint(added)).toBe(md === 'a' ? 'a\n' : md);
    }
    expect(addHint('a\r\n')).toBe(`a\r\n\r\n${CLAUDE_MD_HINT}\r\n`);
  });
});
