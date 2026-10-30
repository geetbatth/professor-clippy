import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runSqliteSmoke } from '../../../scripts/sqlite-smoke.mjs';

const smokeScript = fileURLToPath(new URL('../../../scripts/sqlite-smoke.mjs', import.meta.url));
const electronPath = createRequire(import.meta.url)('electron') as string;

const expectedHits = [{ id: '01B', body: 'Tests failed on the payments service' }];

describe('SQLite driver (node:sqlite + FTS5)', () => {
  it('works under plain Node', () => {
    const result = runSqliteSmoke();
    expect(result).toMatchObject({ ok: true, runtime: 'node' });
    expect(result.fts5Hits.map((h: object) => ({ ...h }))).toEqual(expectedHits);
  });

  it("works under Electron's bundled Node (ELECTRON_RUN_AS_NODE=1)", () => {
    const run = spawnSync(electronPath, [smokeScript], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1)!);
    expect(result).toMatchObject({ ok: true, runtime: expect.stringMatching(/^electron /) });
    expect(result.fts5Hits).toEqual(expectedHits);
  });
});
