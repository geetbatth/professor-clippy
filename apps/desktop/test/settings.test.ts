import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSettingsLenient, SettingsStore } from '../src/main/settings';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'clippy-settings-'));
  file = join(dir, 'settings.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SettingsStore', () => {
  it('starts from the defaults when there is no file, and writes nothing until changed', async () => {
    const s = await SettingsStore.load(file);
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('keeps every valid field of a partly broken file', async () => {
    writeFileSync(file, JSON.stringify({ soundEnabled: false, workerUrl: 'not a url', askTimeoutDefaultS: -5, autoStart: false }));
    const s = await SettingsStore.load(file);
    expect(s.get()).toEqual({ ...DEFAULT_SETTINGS, soundEnabled: false, autoStart: false });
    expect(parseSettingsLenient('nope')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettingsLenient([1])).toEqual(DEFAULT_SETTINGS);
  });

  it('treats unreadable JSON as defaults', async () => {
    writeFileSync(file, '{ broken');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await SettingsStore.load(file)).get()).toEqual(DEFAULT_SETTINGS);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('applies patches (null clears), persists them atomically and notifies listeners', async () => {
    const s = await SettingsStore.load(file);
    const seen: [boolean, boolean][] = [];
    const off = s.onChange((next, prev) => seen.push([next.soundEnabled, prev.soundEnabled]));
    await s.update({ soundEnabled: false, workerUrl: 'https://relay.example.workers.dev', workerSecret: 'shh' });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ soundEnabled: false, workerSecret: 'shh' });
    await s.update({ workerSecret: null });
    expect(s.get().workerSecret).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('workerSecret');
    expect(seen).toEqual([
      [false, true],
      [false, false],
    ]);
    off();
    await s.update({ soundEnabled: true });
    expect(seen).toHaveLength(2);
    expect(readdirSync(dir)).toEqual(['settings.json']); // no temp files left
    expect((await SettingsStore.load(file)).get().soundEnabled).toBe(true);
  });

  it('rejects an invalid patch without changing anything', async () => {
    const s = await SettingsStore.load(file);
    await expect(s.update({ workerUrl: 'definitely not a url' })).rejects.toThrow();
    await expect(s.update({ askTimeoutDefaultS: 0 })).rejects.toThrow();
    expect(s.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('serialises concurrent updates; the last one wins on disk', async () => {
    const s = await SettingsStore.load(file);
    await Promise.all([s.update({ askTimeoutDefaultS: 60 }), s.update({ askTimeoutDefaultS: 120 }), s.update({ hookEnabled: false })]);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ askTimeoutDefaultS: 120, hookEnabled: false });
  });
});
