import { describe, expect, it } from 'vitest';
import { voiceUnavailable } from '../../src/renderer/src/voice/voiceUnavailable';

describe('voiceUnavailable', () => {
  const base = { enabled: true, downloadMb: 558 } as const;
  it('is undefined only when voice is on and ready', () => {
    expect(voiceUnavailable({ ...base, state: 'ready' })).toBeUndefined();
    expect(voiceUnavailable({ ...base, enabled: false, state: 'ready' })).toMatch(/turned off/);
    expect(voiceUnavailable(undefined)).toMatch(/starting/);
  });
  it('says how the download is going', () => {
    expect(voiceUnavailable({ ...base, state: 'missing' })).toMatch(/one-time download \(about 558 MB\)/);
    expect(voiceUnavailable({ ...base, state: 'downloading', progress: 0.5 })).toMatch(/50%/);
    expect(voiceUnavailable({ ...base, state: 'error', error: 'offline' })).toMatch(/offline/);
  });
});
