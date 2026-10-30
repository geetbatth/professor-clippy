import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClippyNotRunningError } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOT_RUNNING_MESSAGE, appCandidates, connectToClippy } from '../src/connect';
import { startFakeApi, type FakeApi } from './fake-api';

let home: string;
let api: FakeApi | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clippy-connect-'));
  process.env.CLIPPY_HOME = home;
});

afterEach(async () => {
  await api?.close();
  api = undefined;
  delete process.env.CLIPPY_HOME;
  await rm(home, { recursive: true, force: true });
});

describe('appCandidates', () => {
  it('prefers CLIPPY_APP_PATH, then the per-user install', () => {
    expect(appCandidates({ CLIPPY_APP_PATH: 'D:/x/clippy.exe', LOCALAPPDATA: 'C:/Users/u/AppData/Local' })).toEqual([
      'D:/x/clippy.exe',
      join('C:/Users/u/AppData/Local', 'Programs', 'professor-clippy', 'Professor Clippy.exe'),
    ]);
    expect(appCandidates({})).toEqual([]);
  });
});

describe('connectToClippy', () => {
  it('connects straight away when the app is running, without launching', async () => {
    api = await startFakeApi(home);
    const launch = vi.fn();
    const client = await connectToClippy({ env: { CLIPPY_APP_PATH: 'C:/x.exe' }, exists: () => true, launch });
    expect(client.baseUrl).toBe(api.url);
    expect(launch).not.toHaveBeenCalled();
  });

  it('fails with the friendly message when nothing is installed', async () => {
    const launch = vi.fn();
    const error = await connectToClippy({ env: { CLIPPY_APP_PATH: 'C:/missing.exe' }, exists: () => false, launch }).catch((e) => e);
    expect(error).toBeInstanceOf(ClippyNotRunningError);
    expect(error.message).toBe(NOT_RUNNING_MESSAGE);
    expect(error.message).toMatch(/^Professor Clippy isn't running/);
    expect(launch).not.toHaveBeenCalled();
  });

  it('launches the first existing candidate and retries until the app answers', async () => {
    const exe = 'C:/Apps/Professor Clippy.exe';
    const launch = vi.fn((_path: string) => {
      setTimeout(async () => (api = await startFakeApi(home)), 150); // app comes up a little later
    });
    const client = await connectToClippy({
      env: { CLIPPY_APP_PATH: exe, LOCALAPPDATA: 'C:/L' },
      exists: (p) => p === exe,
      launch,
      waitMs: 5000,
      pollMs: 50,
    });
    expect(launch).toHaveBeenCalledExactlyOnceWith(exe);
    expect(client.baseUrl).toBe(api!.url);
    await expect(client.health()).resolves.toMatchObject({ ok: true });
  });

  it('gives up after the wait when a launched app never answers', async () => {
    const started = Date.now();
    const error = await connectToClippy({
      env: { CLIPPY_APP_PATH: 'C:/x.exe' },
      exists: () => true,
      launch: () => {},
      waitMs: 300,
      pollMs: 50,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ClippyNotRunningError);
    expect(error.message).toBe(NOT_RUNNING_MESSAGE);
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  });
});
