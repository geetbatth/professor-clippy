/**
 * Optional manual smoke test against the REAL `claude` CLI. Skipped unless CLIPPY_REAL_CLAUDE=1:
 *
 *   npm run build -w apps/mcp
 *   CLIPPY_REAL_CLAUDE=1 npx vitest run test/brain/brain.real.test.ts      (in apps/desktop)
 *
 * One trivial prompt, `--max-turns 1`, the brain's real flag set (read-only tools only) and the
 * built clippy MCP server, run in a temp dir. Checks the CLI accepts every flag, loads the MCP
 * server, and that a reply and session id come back.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Brain, SESSION_KV_KEY } from '../../src/main/brain/brain';
import { findNode, writeBrainFiles } from '../../src/main/brain/mcpConfig';
import { createSpawnRunner, type ClaudeRunner } from '../../src/main/brain/runner';
import { Store } from '../../src/main/core/store';

const mcpServer = resolve(import.meta.dirname, '../../../mcp/dist/index.js');

describe.skipIf(process.env.CLIPPY_REAL_CLAUDE !== '1')('Brain with the real claude CLI (manual)', () => {
  it('answers a trivial prompt with the full brain flag set', { timeout: 120_000 }, async () => {
    expect(existsSync(mcpServer), 'build apps/mcp first').toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'clippy-real-brain-'));
    const store = new Store({ path: ':memory:' });
    try {
      const files = await writeBrainFiles(dir, { serverPath: mcpServer, dataDir: dir, nodePath: findNode(), execPath: process.execPath });
      let raw = '';
      const real = createSpawnRunner();
      const runner: ClaudeRunner = (req, onStdout) =>
        real(req, (chunk) => {
          raw += chunk;
          onStdout(chunk);
        });
      const deltas: string[] = [];
      const brain = new Brain({
        store,
        runner,
        emit: (event, payload) => {
          if (event === 'chat:delta') deltas.push((payload as { text: string }).text);
        },
        mcpConfigPath: files.mcpConfigPath,
        settingsPath: files.settingsPath,
        cwd: dir,
        extraArgs: ['--max-turns', '1'],
      });
      const reply = await brain.ask('Reply with exactly the word: pong');
      const init = JSON.parse(raw.split('\n').find((l) => l.includes('"subtype":"init"'))!);
      console.log('[real brain]', JSON.stringify({ reply, deltas, mcp_servers: init.mcp_servers, tools: init.tools, permissionMode: init.permissionMode }));
      expect(reply.error).toBeUndefined();
      expect(reply.message?.body.toLowerCase()).toContain('pong');
      expect(deltas.join('')).toBe(reply.message?.body);
      expect(store.getKv(SESSION_KV_KEY)).toMatch(/^[0-9a-f-]{36}$/);
      expect(init.mcp_servers).toEqual([expect.objectContaining({ name: 'clippy', status: 'connected' })]);
      expect(init.permissionMode).toBe('dontAsk');
      expect(init.tools).toEqual(expect.arrayContaining(['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'mcp__clippy__leave_message']));
      expect(init.tools).not.toEqual(expect.arrayContaining(['Bash']));
      expect(init.tools).not.toEqual(expect.arrayContaining(['Edit']));
      expect(init.tools).not.toEqual(expect.arrayContaining(['Write']));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
