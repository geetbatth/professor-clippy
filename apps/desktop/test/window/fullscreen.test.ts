import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFullscreenWatcher,
  parseNotificationState,
  probeCommand,
  type ProbeCallbacks,
} from '../../src/main/window/fullscreen';

describe('parseNotificationState', () => {
  it('maps SHQueryUserNotificationState values', () => {
    expect(parseNotificationState('2')).toBe(true); // busy: fullscreen app
    expect(parseNotificationState('3')).toBe(true); // D3D fullscreen
    expect(parseNotificationState('4')).toBe(true); // presentation mode
    expect(parseNotificationState('5\r')).toBe(false); // accepts notifications
    expect(parseNotificationState(' 1 ')).toBe(false); // locked / screen saver
    expect(parseNotificationState('7')).toBe(false);
  });
  it('ignores noise', () => {
    expect(parseNotificationState('')).toBeUndefined();
    expect(parseNotificationState('Add-Type : error')).toBeUndefined();
  });
});

describe('probeCommand', () => {
  it('is one plain line that watches the parent pid and polls at the interval', () => {
    const s = probeCommand(4242, 1500);
    expect(s).not.toContain('\n');
    expect(s).toContain('Get-Process -Id 4242');
    expect(s).toContain('Start-Sleep -Milliseconds 1500');
    expect(s).toContain('SHQueryUserNotificationState');
    expect(s).not.toMatch(/ExecutionPolicy|EncodedCommand/i);
  });
});

/** A fake probe: records spawns; tests drive readings and exits. */
function fakeProbes() {
  const probes: { cb: ProbeCallbacks; kill: ReturnType<typeof vi.fn> }[] = [];
  const spawn = vi.fn((cb: ProbeCallbacks) => {
    const kill = vi.fn();
    probes.push({ cb, kill });
    return { kill };
  });
  return { probes, spawn, last: () => probes.at(-1)! };
}

describe('createFullscreenWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(enabled = true, extra: { maxRestarts?: number } = {}) {
    const flags = { enabled };
    const f = fakeProbes();
    const hide = vi.fn();
    const show = vi.fn();
    const log = vi.fn();
    const watcher = createFullscreenWatcher({
      spawn: f.spawn,
      enabled: () => flags.enabled,
      hide,
      show,
      log,
      syncEveryMs: 1000,
      backoffMs: (n) => n * 100,
      healthyAfterMs: 60_000,
      ...extra,
    });
    return { flags, ...f, hide, show, log, watcher };
  }

  it('hides once while fullscreen and shows again afterwards', () => {
    const { watcher, last, hide, show } = setup();
    watcher.start();
    last().cb.onReading(false);
    last().cb.onReading(true);
    last().cb.onReading(true);
    expect(hide).toHaveBeenCalledTimes(1);
    last().cb.onReading(false);
    last().cb.onReading(false);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('does not run the probe at all while the setting is off', () => {
    const { watcher, spawn, flags } = setup(false);
    watcher.start();
    vi.advanceTimersByTime(5000);
    expect(spawn).not.toHaveBeenCalled();
    flags.enabled = true;
    vi.advanceTimersByTime(1000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('switching the setting off mid-fullscreen kills the probe and shows the window', () => {
    const { watcher, last, flags, show } = setup();
    watcher.start();
    last().cb.onReading(true);
    flags.enabled = false;
    vi.advanceTimersByTime(1000);
    expect(last().kill).toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('shows the window if the probe dies while it is hidden, then restarts with backoff', () => {
    const { watcher, spawn, last, show, log } = setup();
    watcher.start();
    last().cb.onReading(true);
    last().cb.onExit('exited with 1');
    expect(show).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('restarting in 100 ms'));
    vi.advanceTimersByTime(99);
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(2);
    last().cb.onExit('exited with 1');
    vi.advanceTimersByTime(199);
    expect(spawn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('gives up after maxRestarts and logs it, until the setting is toggled', () => {
    const { watcher, spawn, last, log, flags } = setup(true, { maxRestarts: 2 });
    watcher.start();
    for (let i = 0; i < 3; i++) {
      last().cb.onExit('boom');
      vi.advanceTimersByTime(10_000);
    }
    expect(spawn).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining('gave up after 2 restarts'));
    vi.advanceTimersByTime(60_000);
    expect(spawn).toHaveBeenCalledTimes(3);
    flags.enabled = false;
    vi.advanceTimersByTime(1000);
    flags.enabled = true;
    vi.advanceTimersByTime(1000);
    expect(spawn).toHaveBeenCalledTimes(4);
  });

  it('a long healthy run resets the failure count', () => {
    const { watcher, spawn, last } = setup(true, { maxRestarts: 1 });
    watcher.start();
    last().cb.onExit('boom'); // failure 1
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(120_000); // runs healthily for 2 minutes
    last().cb.onExit('boom'); // counts as failure 1 again, not 2
    vi.advanceTimersByTime(100);
    expect(spawn).toHaveBeenCalledTimes(3);
  });

  it('a probe that fails to spawn counts as an exit', () => {
    const show = vi.fn();
    let calls = 0;
    const watcher = createFullscreenWatcher({
      spawn: () => {
        calls += 1;
        throw new Error('ENOENT powershell.exe');
      },
      enabled: () => true,
      hide: vi.fn(),
      show,
      log: vi.fn(),
      backoffMs: () => 100,
    });
    watcher.start();
    vi.advanceTimersByTime(100);
    expect(calls).toBe(2);
    watcher.stop();
  });

  it('stop() kills the probe, shows a hidden window, and ignores late events', () => {
    const { watcher, last, show, hide, spawn } = setup();
    watcher.start();
    const probe = last();
    probe.cb.onReading(true);
    watcher.stop();
    expect(probe.kill).toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
    probe.cb.onReading(true);
    probe.cb.onExit('killed');
    vi.advanceTimersByTime(10_000);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
