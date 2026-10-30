/**
 * "Connect Claude Code". Everything runs against a temp home with a stubbed `claude`; the
 * real ~/.claude is never touched.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLAUDE_MD_HINT, type ClaudeRunner } from '../../../scripts/install-claude-wiring';
import {
  claudeHooksInstalled,
  createClaudeWiring,
  resolveWiringPaths,
  runWiringJob,
  wiringRunner,
  type ClaudeWiringDeps,
  type WiringJob,
} from '../src/main/claudeWiring';

let dir: string;
let home: string;
let paths: { mcpPath: string; hookPath: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clippy-wiring-'));
  home = join(dir, 'home');
  mkdirSync(home);
  paths = { mcpPath: join(dir, 'res', 'mcp', 'index.js'), hookPath: join(dir, 'res', 'hook', 'index.js') };
  for (const p of Object.values(paths)) {
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, '// built');
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A `claude` stand-in that records calls and always succeeds (or fails `mcp add`). */
function fakeClaude(failAdd = false) {
  const calls: string[][] = [];
  const run: ClaudeRunner = (args) => {
    calls.push(args);
    if (failAdd && args[1] === 'add') return { status: 1, stdout: '', stderr: 'boom' };
    return { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

describe('resolveWiringPaths', () => {
  it('uses the shipped copies when packaged, else the repo builds', () => {
    expect(resolveWiringPaths({ resourcesPath: 'C:/App/resources', mainDir: 'x' })).toEqual({
      mcpPath: join('C:/App/resources', 'mcp', 'index.js'),
      hookPath: join('C:/App/resources', 'hook', 'index.js'),
    });
    const mainDir = join(dir, 'apps', 'desktop', 'out', 'main');
    expect(resolveWiringPaths({ mainDir })).toEqual({
      mcpPath: join(dir, 'apps', 'mcp', 'dist', 'index.js'),
      hookPath: join(dir, 'apps', 'hook', 'dist', 'index.js'),
    });
    expect(resolveWiringPaths({ mainDir, mcpOverride: 'D:/mcp.js' }).mcpPath).toBe('D:/mcp.js');
  });
});

describe('runWiringJob', () => {
  it('a dry run lists the plan and changes nothing', () => {
    const claude = fakeClaude();
    const report = runWiringJob({ ...paths, dryRun: true, home }, { runClaude: claude.run });
    expect(report.ok).toBe(true);
    const text = report.log.join('\n');
    expect(text).toContain('[dry-run] would run: claude mcp add --scope user clippy -- node');
    expect(text).toContain(paths.mcpPath.replace(/\\/g, '/'));
    expect(text).toContain('[dry-run] would add Stop + Notification + PermissionRequest hooks');
    expect(text).toContain('[dry-run] would append the Professor Clippy hint');
    expect(claude.calls).toEqual([]);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('installs into the given home, and reports a failure without throwing', () => {
    const lines: string[] = [];
    const ok = runWiringJob({ ...paths, dryRun: false, home }, { runClaude: fakeClaude().run, onLog: (l) => lines.push(l) });
    expect(ok).toMatchObject({ ok: true, warnings: [] });
    expect(lines).toEqual(ok.log);
    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(Object.keys(settings.hooks).sort()).toEqual(['Notification', 'PermissionRequest', 'Stop']);
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain(CLAUDE_MD_HINT);

    const other = join(dir, 'other');
    const bad = runWiringJob({ ...paths, dryRun: false, home: other }, { runClaude: fakeClaude(true).run });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/claude mcp add failed: boom/);
    expect(existsSync(join(other, '.claude', 'settings.json'))).toBe(false);
  });
});

describe('createClaudeWiring', () => {
  function setup(over: Partial<ClaudeWiringDeps> = {}) {
    const installs: WiringJob[] = [];
    const wiring = createClaudeWiring({
      paths,
      home,
      findNode: () => 'C:/node/node.exe',
      findClaude: () => ({ command: 'C:/claude.exe', viaCmd: false }),
      runInstall: async (job) => {
        installs.push(job);
        return runWiringJob(job, { runClaude: fakeClaude().run });
      },
      ...over,
    });
    return { wiring, installs };
  }

  it('only installs after a preview, and installs exactly what was previewed', async () => {
    const { wiring, installs } = setup();
    const early = await wiring.connect('install');
    expect(early).toMatchObject({ ok: false, error: expect.stringMatching(/preview/) });
    expect(installs).toEqual([]);

    const preview = await wiring.connect('preview');
    expect(preview.ok).toBe(true);
    expect(preview.log.some((l) => l.startsWith('[dry-run]'))).toBe(true);
    expect(existsSync(join(home, '.claude'))).toBe(false);

    const done = await wiring.connect('install');
    expect(done).toMatchObject({ ok: true, warnings: [] });
    expect(installs).toEqual([{ ...paths, dryRun: false, home }]);
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);

    // That preview is used up: another install needs a fresh one.
    expect(await wiring.connect('install')).toMatchObject({ ok: false, error: expect.stringMatching(/preview/) });
    expect(installs).toHaveLength(1);
    expect((await wiring.connect('preview')).ok).toBe(true);
    expect((await wiring.connect('install')).ok).toBe(true);
    expect(installs).toHaveLength(2);
  });

  it('warns when node is missing, and blocks when claude or the built files are', async () => {
    const noNode = await setup({ findNode: () => undefined }).wiring.connect('preview');
    expect(noNode.ok).toBe(true);
    expect(noNode.warnings.join(' ')).toMatch(/Node\.js was not found/);

    const { wiring, installs } = setup({ findClaude: () => undefined });
    const noClaude = await wiring.connect('preview');
    expect(noClaude).toMatchObject({ ok: false, error: expect.stringMatching(/Claude Code .* was not found/) });
    expect(noClaude.log.length).toBeGreaterThan(0); // the plan is still shown
    expect((await wiring.connect('install')).ok).toBe(false);
    expect(installs).toEqual([]);

    rmSync(paths.hookPath);
    const noHook = await setup().wiring.connect('preview');
    expect(noHook).toMatchObject({ ok: false, error: expect.stringContaining(paths.hookPath) });
  });

  it('a second click while installing joins the running install', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { wiring, installs } = setup({
      runInstall: async (job) => {
        installs.push(job);
        await gate;
        return { ok: true, log: ['Done.'], warnings: [] };
      },
    });
    await wiring.connect('preview');
    const a = wiring.connect('install');
    const b = wiring.connect('install');
    release();
    expect(await a).toEqual(await b);
    expect(installs).toHaveLength(1);
  });
});

describe('wiringRunner', () => {
  it('runs an exe directly, and a .cmd shim through cmd.exe with quoting', () => {
    expect(wiringRunner(undefined)).toBeUndefined();
    const exe = wiringRunner({ command: process.execPath, viaCmd: false })!;
    const r = exe(['-e', 'console.log(process.argv.slice(1).join("|"))', 'a b', 'c'], process.env);
    expect(r).toMatchObject({ status: 0, stdout: 'a b|c\n' });

    if (process.platform !== 'win32') return;
    const shim = join(dir, 'fake claude.cmd');
    writeFileSync(shim, `@"${process.execPath}" -e "console.log(process.argv.slice(1).join('|'))" %*\r\n`);
    const viaCmd = wiringRunner({ command: shim, viaCmd: true })!;
    const out = viaCmd(['mcp', 'add', '--', 'node', 'C:/Program Files/x.js'], process.env);
    expect(out).toMatchObject({ status: 0, stdout: 'mcp|add|--|node|C:/Program Files/x.js\n' });
  });
});

describe('claudeHooksInstalled', () => {
  it("is true once settings.json has Clippy's hook, false without the file or the hook", async () => {
    expect(await claudeHooksInstalled(home, {})).toBe(false);
    mkdirSync(join(home, '.claude'));
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } }));
    expect(await claudeHooksInstalled(home, {})).toBe(false);
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "C:/x/hook/index.js" --professor-clippy' }] }] } }),
    );
    expect(await claudeHooksInstalled(home, {})).toBe(true);
  });
});
