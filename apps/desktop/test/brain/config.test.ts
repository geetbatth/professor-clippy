import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildMcpConfig, findNode, resolveMcpServerPath, writeBrainFiles } from '../../src/main/brain/mcpConfig';
import { resolveClaude } from '../../src/main/brain/runner';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clippy-brain-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const touch = (...parts: string[]) => {
  const p = join(dir, ...parts);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, '');
  return p;
};

describe('MCP config for the brain', () => {
  it('finds the repo build next to the desktop bundle, a packaged copy, or an override', () => {
    const mainDir = join(dir, 'apps', 'desktop', 'out', 'main');
    expect(resolveMcpServerPath({ mainDir })).toBeUndefined();
    const built = touch('apps', 'mcp', 'dist', 'index.js');
    expect(resolveMcpServerPath({ mainDir })).toBe(built);
    const packaged = touch('resources', 'mcp', 'index.js');
    expect(resolveMcpServerPath({ mainDir, resourcesPath: join(dir, 'resources') })).toBe(packaged);
    const custom = touch('custom.js');
    expect(resolveMcpServerPath({ mainDir, resourcesPath: join(dir, 'resources'), override: custom })).toBe(custom);
  });

  it('points the clippy server at this app with sender clippy-brain', () => {
    expect(buildMcpConfig({ serverPath: 'C:/app/mcp/index.js', dataDir: 'C:/data', nodePath: 'C:/node/node.exe', execPath: 'C:/e.exe' })).toEqual({
      mcpServers: {
        clippy: {
          type: 'stdio',
          command: 'C:/node/node.exe',
          args: ['C:/app/mcp/index.js'],
          env: { CLIPPY_SENDER: 'clippy-brain', CLIPPY_HOME: 'C:/data' },
        },
      },
    });
    // Without node on PATH, Electron itself runs the server in Node mode.
    const fallback = buildMcpConfig({ serverPath: 's.js', dataDir: 'd', nodePath: undefined, execPath: 'C:/Clippy.exe' });
    expect(fallback.mcpServers.clippy).toMatchObject({ command: 'C:/Clippy.exe', env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('writes the config and hook-free settings files', async () => {
    const files = await writeBrainFiles(dir, { serverPath: 's.js', dataDir: dir, nodePath: 'n', execPath: 'e' });
    expect(JSON.parse(readFileSync(files.settingsPath, 'utf8'))).toEqual({ disableAllHooks: true });
    expect(JSON.parse(readFileSync(files.mcpConfigPath!, 'utf8')).mcpServers.clippy.args).toEqual(['s.js']);
    expect((await writeBrainFiles(dir, undefined)).mcpConfigPath).toBeUndefined();
  });

  it('finds node on PATH', () => {
    const nodeDir = join(dir, 'nodejs');
    expect(findNode({ PATH: nodeDir }, 'win32')).toBeUndefined();
    const node = touch('nodejs', 'node.exe');
    expect(findNode({ PATH: `C:\\nowhere;${nodeDir}` }, 'win32')).toBe(node);
  });
});

describe('resolveClaude', () => {
  it('prefers CLIPPY_CLAUDE_PATH, then claude.exe on PATH, then ~/.local/bin, then an npm shim', () => {
    const home = join(dir, 'home');
    const bin = join(dir, 'bin');
    const npm = join(dir, 'npm');
    const env = { PATH: `${bin};${npm}`, USERPROFILE: home };
    expect(resolveClaude(env, 'win32')).toBeUndefined();
    const shim = touch('npm', 'claude.cmd');
    expect(resolveClaude(env, 'win32')).toEqual({ command: shim, viaCmd: true });
    const local = touch('home', '.local', 'bin', 'claude.exe');
    expect(resolveClaude(env, 'win32')).toEqual({ command: local, viaCmd: false });
    const exe = touch('bin', 'claude.exe');
    expect(resolveClaude(env, 'win32')).toEqual({ command: exe, viaCmd: false });
    expect(resolveClaude({ ...env, CLIPPY_CLAUDE_PATH: shim }, 'win32')).toEqual({ command: shim, viaCmd: true });
    expect(resolveClaude({ ...env, CLIPPY_CLAUDE_PATH: join(dir, 'missing.exe') }, 'win32')).toBeUndefined();
    expect(resolveClaude({}, 'linux')).toEqual({ command: 'claude', viaCmd: false });
  });
});
