import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseSettingsLenient, SettingsStore, type SecretBox } from '../src/main/settings';

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

describe('SettingsStore: the Telegram token', () => {
  /** Mock safeStorage: reversible, never the plaintext. */
  const secrets: SecretBox = {
    available: () => true,
    encrypt: (plain) => Buffer.from(`v10${[...plain].reverse().join('')}`).toString('base64'),
    decrypt: (stored) => {
      const raw = Buffer.from(stored, 'base64').toString('utf8');
      if (!raw.startsWith('v10')) throw new Error('bad ciphertext');
      return [...raw.slice(3)].reverse().join('');
    },
  };
  const TOKEN = '123456789:AAHfakeTokenForTestsOnly0123456789';

  it('migrates a plaintext telegramBotToken: encrypts it into telegramBotTokenEnc and removes the plaintext', async () => {
    writeFileSync(file, JSON.stringify({ soundEnabled: false, telegramBotToken: ` ${TOKEN} `, telegramChatId: 4242 }));
    const logs: string[] = [];
    const s = await SettingsStore.load(file, { secrets, log: (m) => logs.push(m) });
    const onDisk = readFileSync(file, 'utf8');
    expect(onDisk).not.toContain(TOKEN);
    expect(onDisk).not.toContain('AAHfakeT');
    const json = JSON.parse(onDisk);
    expect(json).not.toHaveProperty('telegramBotToken');
    expect(json).toMatchObject({ soundEnabled: false, telegramChatId: 4242, telegramBotTokenEnc: secrets.encrypt(TOKEN) });
    expect(s.telegramToken()).toBe(TOKEN);
    expect(s.hasTelegramToken).toBe(true);
    expect(logs.join('\n')).not.toContain('AAHfakeT');
    // Loading again changes nothing.
    const again = await SettingsStore.load(file, { secrets });
    expect(again.telegramToken()).toBe(TOKEN);
    expect(readFileSync(file, 'utf8')).toBe(onDisk);
  });

  it('a new plaintext token replaces the encrypted one', async () => {
    writeFileSync(file, JSON.stringify({ telegramBotTokenEnc: secrets.encrypt('111:old'), telegramBotToken: TOKEN }));
    const s = await SettingsStore.load(file, { secrets, log: () => {} });
    expect(s.telegramToken()).toBe(TOKEN);
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('telegramBotToken');
  });

  it('keeps a plaintext token as it is when this PC cannot encrypt', async () => {
    writeFileSync(file, JSON.stringify({ telegramBotToken: TOKEN }));
    const s = await SettingsStore.load(file, { secrets: { ...secrets, available: () => false }, log: () => {} });
    expect(s.telegramToken()).toBe(TOKEN);
    await s.update({ soundEnabled: false }); // a later write doesn't lose it
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ telegramBotToken: TOKEN, soundEnabled: false });
    await expect(s.setTelegramToken(TOKEN)).rejects.toThrow(/can't encrypt/);
  });

  it('saves a token encrypted, clears it, and refuses anything that is not a token', async () => {
    const s = await SettingsStore.load(file, { secrets });
    const changes: (string | undefined)[] = [];
    s.onChange((next) => changes.push(next.telegramBotTokenEnc));
    await s.setTelegramToken(` ${TOKEN}\n`);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(s.telegramToken()).toBe(TOKEN);
    await expect(s.setTelegramToken('not-a-token')).rejects.toThrow(/bot token/);
    await s.setTelegramToken(null);
    expect(s.hasTelegramToken).toBe(false);
    expect(s.telegramToken()).toBeUndefined();
    expect(JSON.parse(readFileSync(file, 'utf8'))).not.toHaveProperty('telegramBotTokenEnc');
    expect(changes).toEqual([secrets.encrypt(TOKEN), undefined]);
  });

  it('a token that cannot be decrypted here (another user or PC) reads as none', async () => {
    writeFileSync(file, JSON.stringify({ telegramBotTokenEnc: Buffer.from('garbage').toString('base64') }));
    const logs: string[] = [];
    const s = await SettingsStore.load(file, { secrets, log: (m) => logs.push(m) });
    expect(s.hasTelegramToken).toBe(true);
    expect(s.telegramToken()).toBeUndefined();
    expect(logs.join()).toMatch(/cannot be decrypted/);
  });

  it('a failed migration never stops the app: the plaintext is used, kept, and encrypted next time', async () => {
    // Encryption throws.
    writeFileSync(file, JSON.stringify({ soundEnabled: false, telegramBotToken: TOKEN }));
    const logs: string[] = [];
    const broken = { ...secrets, encrypt: () => { throw new Error(`DPAPI said no to ${TOKEN}`); } };
    const s = await SettingsStore.load(file, { secrets: broken, log: (m) => logs.push(m) });
    expect(s.telegramToken()).toBe(TOKEN);
    expect(s.get().soundEnabled).toBe(false);
    expect(s.get()).not.toHaveProperty('telegramBotTokenEnc');
    expect(logs.join('\n')).toMatch(/could not encrypt the Telegram bot token .*trying again next start/);
    expect(logs.join('\n')).not.toContain('AAHfakeT');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ telegramBotToken: TOKEN });

    // Rewriting the file fails (Windows: renaming over a read-only file is EPERM, as when
    // antivirus or OneDrive holds it).
    chmodSync(file, 0o444);
    try {
      const held = await SettingsStore.load(file, { secrets, log: (m) => logs.push(m) });
      expect(held.telegramToken()).toBe(TOKEN);
      expect(held.get()).not.toHaveProperty('telegramBotTokenEnc');
    } finally {
      chmodSync(file, 0o666);
    }
    expect(readFileSync(file, 'utf8')).toContain(TOKEN); // untouched

    // Next start, all is well: migrated.
    const ok = await SettingsStore.load(file, { secrets, log: () => {} });
    expect(ok.telegramToken()).toBe(TOKEN);
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
  });

  it('without a SecretBox (tests, tools) no token can be saved', async () => {
    const s = await SettingsStore.load(file);
    await expect(s.setTelegramToken(TOKEN)).rejects.toThrow(/can't encrypt/);
  });
});
