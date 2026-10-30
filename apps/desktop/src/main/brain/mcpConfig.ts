/**
 * Files the brain's `claude` run is pointed at:
 * - `brain-mcp.json` (`--mcp-config`): the built clippy MCP server, with `CLIPPY_SENDER=clippy-brain`,
 *   `CLIPPY_HOME` = this app's data dir, so it reaches this app's local API, and
 *   `CLIPPY_POWER_TOOLS=1`, so the brain (and no other agent) gets the restart request tools.
 * - `brain-settings.json` (`--settings`): `disableAllHooks`, so the user's Claude Code hooks
 *   (including Clippy's own Stop hook) don't fire for Clippy's turns.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { BRAIN_SENDER } from '@clippy/shared';
import { writeAtomic } from '../core/files';

export interface McpServerLocation {
  /** Overrides everything (env `CLIPPY_MCP_PATH`). */
  override?: string | undefined;
  /** `process.resourcesPath` of a packaged app (looked up as `<resources>/mcp/index.js`). */
  resourcesPath?: string | undefined;
  /** Directory of the main bundle (`apps/desktop/out/main`); the repo build is `../../../mcp/dist/index.js`. */
  mainDir: string;
}

/** Path of the built MCP server (`apps/mcp/dist/index.js`), or undefined if it isn't built. */
export function resolveMcpServerPath(loc: McpServerLocation): string | undefined {
  const candidates = [
    loc.override,
    loc.resourcesPath && join(loc.resourcesPath, 'mcp', 'index.js'),
    resolve(loc.mainDir, '../../../mcp/dist/index.js'),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p));
}

/** `node` on PATH, if any. */
export function findNode(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const name = platform === 'win32' ? 'node.exe' : 'node';
  return (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((d) => join(d, name))
    .find((p) => existsSync(p));
}

export interface McpConfigInput {
  serverPath: string;
  dataDir: string;
  /** `node` executable; when undefined, this Electron binary is used in Node mode instead. */
  nodePath: string | undefined;
  /** Electron's `process.execPath` (fallback runtime). */
  execPath: string;
}

export function buildMcpConfig(input: McpConfigInput): { mcpServers: Record<string, unknown> } {
  const env: Record<string, string> = { CLIPPY_SENDER: BRAIN_SENDER, CLIPPY_HOME: input.dataDir, CLIPPY_POWER_TOOLS: '1' };
  if (!input.nodePath) env.ELECTRON_RUN_AS_NODE = '1';
  return {
    mcpServers: {
      clippy: { type: 'stdio', command: input.nodePath ?? input.execPath, args: [input.serverPath], env },
    },
  };
}

export const BRAIN_SETTINGS = { disableAllHooks: true } as const;

export interface BrainFiles {
  /** Undefined when the MCP server isn't built (the brain then runs without the clippy tools). */
  mcpConfigPath: string | undefined;
  settingsPath: string;
}

/** Write the brain's config files into `<dataDir>/brain/`. */
export async function writeBrainFiles(dataDir: string, mcp: McpConfigInput | undefined): Promise<BrainFiles> {
  const dir = join(dataDir, 'brain');
  await mkdir(dir, { recursive: true });
  const settingsPath = join(dir, 'brain-settings.json');
  await writeAtomic(settingsPath, `${JSON.stringify(BRAIN_SETTINGS, null, 2)}\n`);
  let mcpConfigPath: string | undefined;
  if (mcp) {
    mcpConfigPath = join(dir, 'brain-mcp.json');
    await writeAtomic(mcpConfigPath, `${JSON.stringify(buildMcpConfig(mcp), null, 2)}\n`);
  }
  return { mcpConfigPath, settingsPath };
}
