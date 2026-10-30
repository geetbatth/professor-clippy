import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WINDOW_SIZES, WindowChannels } from '../../src/main/window/windowApi';

type Listener = (e: { sender: unknown }, ...args: unknown[]) => void;
type Rect = { x: number; y: number; width: number; height: number };

const h = vi.hoisted(() => {
  const state = {
    listeners: new Map<string, Listener>(),
    screenListeners: new Map<string, () => void>(),
    cursor: { x: 0, y: 0 },
    displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    windows: [] as FakeWindow[],
  };
  class FakeWindow {
    bounds: Rect;
    handlers = new Map<string, () => void>();
    webContents = {
      setWindowOpenHandler: () => {},
      on: () => {},
      send: () => {},
      isDestroyed: () => false,
    };
    setIgnoreMouseEvents = vi.fn();
    setAlwaysOnTop = vi.fn();
    setBounds = vi.fn((r: Rect) => {
      this.bounds = { ...r };
    });
    constructor(opts: Rect) {
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      state.windows.push(this);
    }
    getBounds = () => ({ ...this.bounds });
    getContentBounds = () => ({ ...this.bounds });
    isDestroyed = () => false;
    isVisible = () => true;
    hide = vi.fn();
    showInactive = vi.fn();
    once = (event: string, cb: () => void) => this.handlers.set(event, cb);
    on = (event: string, cb: () => void) => this.handlers.set(event, cb);
    loadFile = vi.fn(async () => {});
    loadURL = vi.fn(async () => {});
  }
  return { state, FakeWindow };
});

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: h.FakeWindow,
  ipcMain: {
    on: (channel: string, fn: Listener) => h.state.listeners.set(channel, fn),
    removeListener: (channel: string) => h.state.listeners.delete(channel),
  },
  screen: {
    getAllDisplays: () => h.state.displays,
    getPrimaryDisplay: () => h.state.displays[0],
    getCursorScreenPoint: () => ({ ...h.state.cursor }),
    on: (event: string, fn: () => void) => h.state.screenListeners.set(event, fn),
    removeListener: (event: string) => h.state.screenListeners.delete(event),
  },
}));

const { createClippyWindow } = await import('../../src/main/window/createClippyWindow');

function setup(saved?: { x: number; y: number; displayId: number }) {
  const savePos = vi.fn();
  const clippy = createClippyWindow({ loadPos: () => saved, savePos, hideOnFullscreen: () => true, fullscreenProbe: null });
  const win = h.state.windows.at(-1)!;
  const me = { sender: clippy.win.webContents };
  const send = (channel: string, ...args: unknown[]) => h.state.listeners.get(channel)!(me, ...args);
  return { clippy, win, savePos, send, me };
}

describe('createClippyWindow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.state.listeners.clear();
    h.state.windows.length = 0;
    h.state.displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  });
  afterEach(() => {
    h.state.windows.forEach((w) => w.handlers.get('closed')?.());
    vi.useRealTimers();
  });

  it('starts as a click-through mini window in the bottom-right corner', () => {
    const { win } = setup();
    expect(win.bounds).toEqual({ x: 1920 - WINDOW_SIZES.mini.width - 16, y: 1040 - WINDOW_SIZES.mini.height - 16, ...WINDOW_SIZES.mini });
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true });
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
  });

  it('ignoreMouse toggles click-through and ignores junk', () => {
    const { win, send } = setup();
    win.setIgnoreMouseEvents.mockClear();
    send(WindowChannels.ignoreMouse, false);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    send(WindowChannels.ignoreMouse, true);
    expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    send(WindowChannels.ignoreMouse, 'yes');
    expect(win.setIgnoreMouseEvents).toHaveBeenCalledTimes(2);
  });

  it('mode switches sizes with top-right corners aligned, and ignores bad modes', () => {
    const { win, send, clippy } = setup({ x: 1000, y: 100, displayId: 1 });
    send(WindowChannels.mode, 'expanded');
    expect(win.bounds).toEqual({ x: 1000 + WINDOW_SIZES.mini.width - WINDOW_SIZES.expanded.width, y: 100, ...WINDOW_SIZES.expanded });
    expect(clippy.getMode()).toBe('expanded');
    send(WindowChannels.mode, 'huge');
    expect(clippy.getMode()).toBe('expanded');
    send(WindowChannels.mode, 'mini');
    expect(win.bounds).toEqual({ x: 1000, y: 100, ...WINDOW_SIZES.mini });
  });

  it('drags with the cursor, clamps on release and saves the position', () => {
    const { win, send, savePos } = setup({ x: 1000, y: 100, displayId: 1 });
    h.state.cursor = { x: 1050, y: 150 };
    send(WindowChannels.dragStart);
    h.state.cursor = { x: 850, y: 400 };
    send(WindowChannels.dragMove);
    expect(win.bounds).toMatchObject({ x: 800, y: 350, ...WINDOW_SIZES.mini });
    h.state.cursor = { x: -500, y: 400 }; // dragged off the left edge
    send(WindowChannels.dragMove);
    send(WindowChannels.dragEnd);
    expect(win.bounds).toMatchObject({ x: 0, y: 350 });
    expect(savePos).toHaveBeenCalledExactlyOnceWith({ x: 0, y: 350, displayId: 1 });
  });

  it('a click (drag without movement) does not save', () => {
    const { send, savePos } = setup({ x: 1000, y: 100, displayId: 1 });
    h.state.cursor = { x: 1050, y: 150 };
    send(WindowChannels.dragStart);
    send(WindowChannels.dragEnd);
    expect(savePos).not.toHaveBeenCalled();
  });

  it('dragging the expanded note saves the matching mini position', () => {
    const { send, savePos } = setup({ x: 1000, y: 100, displayId: 1 });
    send(WindowChannels.mode, 'expanded');
    h.state.cursor = { x: 900, y: 120 };
    send(WindowChannels.dragStart);
    h.state.cursor = { x: 800, y: 220 };
    send(WindowChannels.dragMove);
    send(WindowChannels.dragEnd);
    expect(savePos).toHaveBeenCalledExactlyOnceWith({ x: 900, y: 200, displayId: 1 });
  });

  it('ignores window messages from any other web contents', () => {
    const { win, savePos } = setup();
    const stranger = { sender: {} };
    win.setIgnoreMouseEvents.mockClear();
    win.setBounds.mockClear();
    h.state.listeners.get(WindowChannels.ignoreMouse)!(stranger, false);
    h.state.listeners.get(WindowChannels.mode)!(stranger, 'expanded');
    h.state.listeners.get(WindowChannels.dragStart)!(stranger);
    h.state.listeners.get(WindowChannels.dragEnd)!(stranger);
    expect(win.setIgnoreMouseEvents).not.toHaveBeenCalled();
    expect(win.setBounds).not.toHaveBeenCalled();
    expect(savePos).not.toHaveBeenCalled();
  });

  it('display changes clamp the window but never rewrite the saved position', () => {
    h.state.displays = [
      { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } },
      { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } },
    ];
    const { win, savePos } = setup({ x: 2500, y: 300, displayId: 2 });
    expect(win.bounds).toMatchObject({ x: 2500, y: 300 });
    // Unplug the second monitor: Clippy moves onto the first...
    h.state.displays = [h.state.displays[0]!];
    h.state.screenListeners.get('display-removed')!();
    expect(win.bounds).toMatchObject({ x: 1920 - WINDOW_SIZES.mini.width, y: 300 });
    // ...and goes back when it returns, with nothing saved in between.
    h.state.displays = [h.state.displays[0]!, { id: 2, workArea: { x: 1920, y: 0, width: 1920, height: 1040 } }];
    h.state.screenListeners.get('display-metrics-changed')!();
    expect(win.bounds).toMatchObject({ x: 2500, y: 300 });
    expect(savePos).not.toHaveBeenCalled();
  });

  it('starting with a saved position on a missing display clamps without saving, even after a click', () => {
    const { win, savePos, send } = setup({ x: 5000, y: 300, displayId: 9 });
    expect(win.bounds).toMatchObject({ x: 1920 - WINDOW_SIZES.mini.width, y: 300 });
    h.state.cursor = { x: 1850, y: 350 };
    send(WindowChannels.dragStart);
    send(WindowChannels.dragMove); // cursor hasn't moved
    send(WindowChannels.dragEnd);
    expect(savePos).not.toHaveBeenCalled();
  });

  it('removes its IPC listeners when the window closes', () => {
    const { win } = setup();
    expect(h.state.listeners.size).toBe(Object.keys(WindowChannels).length - 2); // not the main->renderer ones
    win.handlers.get('closed')!();
    expect(h.state.listeners.size).toBe(0);
  });
});
