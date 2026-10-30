import { describe, expect, it } from 'vitest';
import { applySettingsPatch, DEFAULT_SETTINGS, Settings, SettingsPatch } from '../src/settings';

describe('Settings', () => {
  it('fills every default from an empty object', () => {
    expect(Settings.parse({})).toEqual({
      hookEnabled: true,
      soundEnabled: true,
      unsolicitedAdvice: true,
      askTimeoutDefaultS: 600,
      hideOnFullscreen: true,
      autoStart: true,
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
