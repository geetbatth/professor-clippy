import { describe, expect, it, vi } from 'vitest';
import { IpcEvents } from '@clippy/shared/ipc';
import { forwardSystemTheme } from '../../src/main/window/systemTheme';

function fakeNativeTheme(dark = false) {
  const listeners: (() => void)[] = [];
  return {
    shouldUseDarkColors: dark,
    on: (_event: 'updated', cb: () => void) => void listeners.push(cb),
    off: (_event: 'updated', cb: () => void) => void listeners.splice(listeners.indexOf(cb), 1),
    /** Windows switched. */
    switchTo(next: boolean) {
      this.shouldUseDarkColors = next;
      for (const cb of [...listeners]) cb();
    },
    listenerCount: () => listeners.length,
  };
}

function fakeWindow(destroyed = false) {
  const contents = { send: vi.fn(), isDestroyed: () => destroyed };
  return { webContents: contents, isDestroyed: () => destroyed };
}

describe('forwardSystemTheme', () => {
  it('sends theme:system to every window when Windows switches, with the new state', () => {
    const native = fakeNativeTheme(false);
    const a = fakeWindow();
    const b = fakeWindow();
    forwardSystemTheme(native, () => [a, b] as never);
    native.switchTo(true);
    expect(a.webContents.send).toHaveBeenCalledWith(IpcEvents.themeSystem, true);
    expect(b.webContents.send).toHaveBeenCalledWith(IpcEvents.themeSystem, true);
    native.switchTo(false);
    expect(a.webContents.send).toHaveBeenLastCalledWith('theme:system', false);
  });

  it('says nothing until Windows switches, and skips windows that are gone', () => {
    const native = fakeNativeTheme(true);
    const live = fakeWindow();
    const gone = fakeWindow(true);
    forwardSystemTheme(native, () => [live, gone] as never);
    expect(live.webContents.send).not.toHaveBeenCalled();
    native.switchTo(false);
    expect(live.webContents.send).toHaveBeenCalledOnce();
    expect(gone.webContents.send).not.toHaveBeenCalled();
  });

  it('reaches windows opened after it started, and stops when told to', () => {
    const native = fakeNativeTheme();
    const windows: ReturnType<typeof fakeWindow>[] = [];
    const stop = forwardSystemTheme(native, () => windows as never);
    const late = fakeWindow();
    windows.push(late);
    native.switchTo(true);
    expect(late.webContents.send).toHaveBeenCalledWith('theme:system', true);
    stop();
    expect(native.listenerCount()).toBe(0);
  });
});
