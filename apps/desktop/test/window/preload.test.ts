import { describe, expect, it, vi } from 'vitest';
import { IpcEvents, IpcInvoke, type ClippyWindowApi } from '@clippy/shared/ipc';
import { WindowChannels, type ClippyWindowShell } from '../../src/main/window/windowApi';

const exposed: Record<string, unknown> = {};
const ipcRenderer = {
  invoke: vi.fn(async (..._args: unknown[]) => 'ok'),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
};

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: (key: string, api: unknown) => (exposed[key] = api) },
  ipcRenderer,
}));

await import('../../src/preload/index');
const clippy = exposed.clippy as ClippyWindowApi;
const shell = exposed.clippyWindow as ClippyWindowShell;

describe('preload', () => {
  it('exposes every backend method over ipcRenderer.invoke', async () => {
    for (const [method, channel] of Object.entries(IpcInvoke)) {
      expect(typeof (clippy as unknown as Record<string, unknown>)[method]).toBe('function');
      ipcRenderer.invoke.mockClear();
      await (clippy as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method]!('a', 1);
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, 'a', 1);
    }
  });

  it('on() subscribes to known events and unsubscribes cleanly, hiding the IPC event object', () => {
    for (const event of Object.values(IpcEvents)) {
      const cb = vi.fn();
      ipcRenderer.on.mockClear();
      const off = clippy.on(event, cb);
      const [channel, listener] = ipcRenderer.on.mock.calls[0] as [string, (...a: unknown[]) => void];
      expect(channel).toBe(event);
      listener({ sender: 'secret' }, 'payload');
      expect(cb).toHaveBeenCalledWith('payload');
      off();
      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(event, listener);
    }
  });

  it('on() refuses unknown channels', () => {
    ipcRenderer.on.mockClear();
    expect(() => clippy.on('clippy:markDone' as never, () => {})).toThrow(/Unknown Clippy event/);
    expect(() => clippy.on('window:cursor' as never, () => {})).toThrow(/Unknown Clippy event/);
    expect(ipcRenderer.on).not.toHaveBeenCalled();
  });

  it('exposes the window shell', () => {
    shell.setMode('expanded');
    expect(ipcRenderer.send).toHaveBeenCalledWith(WindowChannels.mode, 'expanded');
    ipcRenderer.send.mockClear();
    shell.setMode('huge' as never);
    expect(ipcRenderer.send).not.toHaveBeenCalled();
    shell.setIgnoreMouse(false);
    expect(ipcRenderer.send).toHaveBeenCalledWith(WindowChannels.ignoreMouse, false);
    shell.dragStart();
    shell.dragMove();
    shell.dragEnd();
    expect(ipcRenderer.send).toHaveBeenCalledWith(WindowChannels.dragEnd);
    const cb = vi.fn();
    shell.onCursor(cb);
    const [channel, listener] = ipcRenderer.on.mock.calls.at(-1) as [string, (...a: unknown[]) => void];
    expect(channel).toBe(WindowChannels.cursor);
    listener({}, { x: 1, y: 2 });
    expect(cb).toHaveBeenCalledWith({ x: 1, y: 2 });
  });
});
