import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { ClippyDO } from '../src/index';

describe('relay worker skeleton', () => {
  it('answers /health and 404s anything else', async () => {
    const health = await exports.default.fetch('https://relay.test/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    expect((await exports.default.fetch('https://relay.test/nope')).status).toBe(404);
  });

  it('binds CLIPPY to a SQLite-backed ClippyDO', async () => {
    const stub = env.CLIPPY.getByName('relay');
    await runInDurableObject(stub, (instance, state) => {
      expect(instance).toBeInstanceOf(ClippyDO);
      // `storage.sql` only exists on SQLite-backed objects (new_sqlite_classes).
      state.storage.sql.exec('CREATE TABLE probe (v TEXT)');
      state.storage.sql.exec('INSERT INTO probe VALUES (?)', 'ok');
      expect(state.storage.sql.exec<{ v: string }>('SELECT v FROM probe').one().v).toBe('ok');
    });
  });
});
