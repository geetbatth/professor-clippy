import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appDataDir, dbPath, portPath, settingsPath, tokenPath } from '../src/paths';

describe('paths', () => {
  beforeEach(() => {
    vi.stubEnv('CLIPPY_HOME', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to %APPDATA%/professor-clippy', () => {
    const roaming = resolve('Users', 'me', 'AppData', 'Roaming');
    vi.stubEnv('APPDATA', roaming);
    expect(appDataDir()).toBe(join(roaming, 'professor-clippy'));
  });

  it('honours CLIPPY_HOME (resolved to an absolute path)', () => {
    vi.stubEnv('CLIPPY_HOME', 'some/relative/home');
    expect(appDataDir()).toBe(resolve('some/relative/home'));
  });

  it('places every file inside the app data dir', () => {
    const home = resolve('clippy-test-home');
    vi.stubEnv('CLIPPY_HOME', home);
    expect(tokenPath()).toBe(join(home, 'token'));
    expect(portPath()).toBe(join(home, 'port'));
    expect(dbPath()).toBe(join(home, 'clippy.db'));
    expect(settingsPath()).toBe(join(home, 'settings.json'));
  });

  it('re-reads CLIPPY_HOME on every call', () => {
    vi.stubEnv('CLIPPY_HOME', resolve('a'));
    expect(tokenPath()).toBe(join(resolve('a'), 'token'));
    vi.stubEnv('CLIPPY_HOME', resolve('b'));
    expect(tokenPath()).toBe(join(resolve('b'), 'token'));
  });
});
