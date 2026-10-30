import { describe, expect, it } from 'vitest';
import { chooseBackend } from '../../src/renderer/src/backendChoice';

describe('chooseBackend', () => {
  it('uses the preload bridge when it is there', () => {
    expect(chooseBackend({ search: '', hasPreload: true, dev: false })).toBe('real');
    expect(chooseBackend({ search: '?mode=expanded', hasPreload: true, dev: true })).toBe('real');
  });

  it('uses the mock only when asked, or in a dev build without a preload', () => {
    expect(chooseBackend({ search: '?mock=1', hasPreload: true, dev: false })).toBe('mock');
    expect(chooseBackend({ search: '?mock=1', hasPreload: false, dev: false })).toBe('mock');
    expect(chooseBackend({ search: '', hasPreload: false, dev: true })).toBe('mock');
  });

  it('never falls back to fake notes in a production build with a broken preload', () => {
    expect(chooseBackend({ search: '', hasPreload: false, dev: false })).toBe('missing');
    expect(chooseBackend({ search: '?mock=0', hasPreload: false, dev: false })).toBe('missing');
  });
});
