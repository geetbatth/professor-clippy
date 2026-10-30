import { describe, expect, it } from 'vitest';
import { applySettingsPatch, DEFAULT_SETTINGS, Settings, SettingsPatch } from '../src/settings';

describe('Settings', () => {
  it('fills every default from an empty object', () => {
    expect(Settings.parse({})).toEqual({
      hookEnabled: true,
      awayThresholdS: 180,
      soundEnabled: true,
      popUpFor: 'important',
      phoneWhen: 'away',
      unsolicitedAdvice: false,
      askTimeoutDefaultS: 600,
      tellHotkey: 'Control+Alt+Space',
      hideOnFullscreen: true,
      autoStart: true,
      firstRunDone: false,
      quietDefaultsApplied: false,
    });
    expect(DEFAULT_SETTINGS).toEqual(Settings.parse({}));
  });

  it('keeps stored values and optional fields', () => {
    const stored = {
      soundEnabled: false,
      askTimeoutDefaultS: 120,
      workerUrl: 'https://clippy.example.workers.dev',
      workerSecret: 's3cret',
      windowPos: { x: 10, y: 20, displayId: 2528732444 },
    };
    expect(Settings.parse(stored)).toMatchObject(stored);
  });

  it('rejects invalid values', () => {
    expect(Settings.safeParse({ askTimeoutDefaultS: 0 }).success).toBe(false);
    expect(Settings.safeParse({ workerUrl: 'not a url' }).success).toBe(false);
    expect(Settings.safeParse({ awayThresholdS: -1 }).success).toBe(false);
    expect(Settings.safeParse({ awayThresholdS: 1.5 }).success).toBe(false);
  });

  it('accepts an away threshold of 0 (always interrupt) and patches it', () => {
    expect(Settings.parse({ awayThresholdS: 0 }).awayThresholdS).toBe(0);
    expect(SettingsPatch.parse({ awayThresholdS: 600 })).toEqual({ awayThresholdS: 600 });
  });
});

describe('Settings: phoneWhen', () => {
  it('defaults to away, accepts always, rejects anything else, and is patchable', () => {
    expect(Settings.parse({}).phoneWhen).toBe('away');
    expect(Settings.parse({ phoneWhen: 'always' }).phoneWhen).toBe('always');
    expect(Settings.safeParse({ phoneWhen: 'never' }).success).toBe(false);
    expect(SettingsPatch.parse({ phoneWhen: 'always' })).toEqual({ phoneWhen: 'always' });
  });
});

describe('Settings: tellHotkey', () => {
  it('defaults to Control+Alt+Space, may be empty (off), is capped at 60 chars and patchable', () => {
    expect(Settings.parse({}).tellHotkey).toBe('Control+Alt+Space');
    expect(Settings.parse({ tellHotkey: '' }).tellHotkey).toBe('');
    expect(Settings.safeParse({ tellHotkey: 'x'.repeat(61) }).success).toBe(false);
    expect(SettingsPatch.parse({ tellHotkey: 'Alt+T' })).toEqual({ tellHotkey: 'Alt+T' });
  });
});

describe('Settings: quiet by default', () => {
  it('pops up for important things only, with advice quips off', () => {
    const s = Settings.parse({});
    expect(s.popUpFor).toBe('important');
    expect(s.unsolicitedAdvice).toBe(false);
    expect(s.quietDefaultsApplied).toBe(false);
    expect(Settings.parse({ popUpFor: 'everything' }).popUpFor).toBe('everything');
    expect(Settings.safeParse({ popUpFor: 'nothing' }).success).toBe(false);
    expect(SettingsPatch.parse({ popUpFor: 'everything' })).toEqual({ popUpFor: 'everything' });
  });

  it('the migration marker is not patchable', () => {
    expect(SettingsPatch.parse({ quietDefaultsApplied: true })).toEqual({});
    expect(applySettingsPatch(Settings.parse({ quietDefaultsApplied: true }), { soundEnabled: false }).quietDefaultsApplied).toBe(true);
  });
});

describe('Settings: Telegram', () => {
  it('keeps the encrypted token and the paired chat, and accepts a numeric-string chat id', () => {
    expect(Settings.parse({ telegramBotTokenEnc: 'djEwAAAA', telegramChatId: 123456789, telegramChatName: 'Geet' })).toMatchObject({
      telegramBotTokenEnc: 'djEwAAAA',
      telegramChatId: 123456789,
      telegramChatName: 'Geet',
    });
    expect(Settings.parse({ telegramChatId: '987654321' }).telegramChatId).toBe(987654321);
    expect(Settings.safeParse({ telegramChatId: 1.5 }).success).toBe(false);
    expect(Settings.safeParse({ telegramChatId: 'abc' }).success).toBe(false);
  });

  it('refuses group and channel chat ids (zero or negative): private chats only', () => {
    expect(Settings.safeParse({ telegramChatId: -1001234567890 }).success).toBe(false);
    expect(Settings.safeParse({ telegramChatId: '-42' }).success).toBe(false);
    expect(Settings.safeParse({ telegramChatId: 0 }).success).toBe(false);
    expect(SettingsPatch.safeParse({ telegramChatId: -5 }).success).toBe(false);
  });

  it('never carries a plaintext token, and the token is not patchable', () => {
    expect(Settings.parse({ telegramBotToken: '123:abc' })).not.toHaveProperty('telegramBotToken');
    expect(SettingsPatch.parse({ telegramBotTokenEnc: 'x', telegramBotToken: 'y' })).toEqual({});
    expect(SettingsPatch.parse({ telegramChatId: null, telegramChatName: null })).toEqual({ telegramChatId: null, telegramChatName: null });
  });
});

describe('SettingsPatch', () => {
  it('applies no defaults', () => {
    expect(SettingsPatch.parse({})).toEqual({});
    expect(SettingsPatch.parse({ soundEnabled: false })).toEqual({ soundEnabled: false });
  });

  it('allows null only for the clearable optional keys', () => {
    expect(SettingsPatch.safeParse({ workerUrl: null }).success).toBe(true);
    expect(SettingsPatch.safeParse({ windowPos: null }).success).toBe(true);
    expect(SettingsPatch.safeParse({ soundEnabled: null }).success).toBe(false);
  });
});

describe('applySettingsPatch', () => {
  const current = Settings.parse({ workerUrl: 'https://w.example', workerSecret: 'x' });

  it('replaces given keys and keeps the rest', () => {
    const next = applySettingsPatch(current, { soundEnabled: false });
    expect(next).toEqual({ ...current, soundEnabled: false });
    expect(current.soundEnabled).toBe(true); // input not mutated
  });

  it('clears optional keys set to null', () => {
    const next = applySettingsPatch(current, { workerUrl: null, workerSecret: null });
    expect(next).not.toHaveProperty('workerUrl');
    expect(next).not.toHaveProperty('workerSecret');
  });

  it('ignores undefined values', () => {
    expect(applySettingsPatch(current, { autoStart: undefined })).toEqual(current);
  });
});
