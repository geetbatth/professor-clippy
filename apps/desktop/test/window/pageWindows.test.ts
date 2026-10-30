import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Page, PageBounds, ThemeId } from '@clippy/shared';
import { Bus } from '../../src/main/core/bus';
import { PAGE_HEADER_HEIGHT, PageWindowChannels } from '../../src/main/window/windowApi';

type Rect = { x: number; y: number; width: number; height: number };
type Listener = (e: { sender: unknown }, ...args: unknown[]) => void;

const h = vi.hoisted(() => {
  const state = {
    ipc: new Map<string, Listener>(),
    displays: [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    windows: [] as FakeWindow[],
    cursor: { x: 0, y: 0 },
  };
  class FakeWindow {
    opts: Record<string, unknown>;
    bounds: Rect;
    handlers = new Map<string, ((e: { preventDefault(): void }) => void)[]>();
    destroyed = false;
    webContents = { setWindowOpenHandler: vi.fn(), on: vi.fn() };
    constructor(opts: Rect & Record<string, unknown>) {
      this.opts = opts;
      this.bounds = { x: opts.x, y: opts.y, width: opts.width, height: opts.height };
      state.windows.push(this);
    }
    on(event: string, cb: (e: { preventDefault(): void }) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    }
    once = this.on;
    emit(event: string): boolean {
      let prevented = false;
      for (const cb of this.handlers.get(event) ?? []) cb({ preventDefault: () => (prevented = true) });
      return prevented;
    }
    getBounds = () => ({ ...this.bounds });
    setBounds = vi.fn((r: Rect) => {
      this.bounds = { ...r };
      this.emit('resize');
    });
    setMinimumSize = vi.fn();
    setResizable = vi.fn();
    setTitle = vi.fn();
    showInactive = vi.fn();
    isDestroyed = () => this.destroyed;
    close = vi.fn(() => {
      if (this.emit('close')) return;
      this.destroyed = true;
      this.emit('closed');
    });
    loadFile = vi.fn(async () => {});
    loadURL = vi.fn(async () => {});
  }
  return { state, FakeWindow };
});

vi.mock('electron', () => ({
  app: { isPackaged: true },
  BrowserWindow: h.FakeWindow,
  ipcMain: {
    on: (channel: string, fn: Listener) => h.state.ipc.set(channel, fn),
    removeListener: (channel: string) => h.state.ipc.delete(channel),
  },
  screen: {
    getAllDisplays: () => h.state.displays,
    getPrimaryDisplay: () => h.state.displays[0],
    getDisplayMatching: () => h.state.displays[0],
    getCursorScreenPoint: () => ({ ...h.state.cursor }),
  },
}));

const { BOUNDS_SAVE_DELAY_MS, createPageWindows } = await import('../../src/main/window/pageWindows');

function makePage(over: Partial<Page> = {}): Page {
  return {
    id: '01JC0000000000000000000001',
    title: 'Scratch',
    body: '',
    color: null,
    pinned: false,
    popped: true,
    popBounds: null,
    author: 'you',
    project: null,
    unseen: false,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...over,
  };
}

function setup(stored: Page[] = [], extra: { theme?: () => ThemeId } = {}) {
  const bus = new Bus();
  let quitting = false;
  const pages = {
    list: vi.fn(() => stored),
    setPopped: vi.fn((id: string, popped: boolean, bounds?: PageBounds) => {
      const page = makePage({ id, popped, ...(bounds && { popBounds: bounds }) });
      bus.emit('page:changed', page);
      return page;
    }),
  };
  const windows = createPageWindows({ pages, bus, quitting: () => quitting, log: () => {}, ...extra });
  return { bus, pages, windows, quit: () => (quitting = true) };
}

describe('createPageWindows', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    h.state.windows.length = 0;
    h.state.ipc.clear();
    h.state.displays = [{ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }];
  });
  afterEach(() => vi.useRealTimers());

  it('opens a frameless, transparent, resizable window off the taskbar for a page that pops out, loading ?page=<id>', () => {
    const { bus, windows } = setup();
    bus.emit('page:changed', makePage());
    expect(h.state.windows).toHaveLength(1);
    const win = h.state.windows[0]!;
    expect(win.opts).toMatchObject({
      frame: false,
      transparent: true,
      resizable: true,
      skipTaskbar: true,
      minWidth: 180,
      minHeight: 120,
      width: 260,
      height: 220,
    });
    expect(win.opts.alwaysOnTop).toBeUndefined();
    expect(win.loadFile).toHaveBeenCalledWith(expect.stringMatching(/renderer[\\/]index\.html$/), { query: { page: makePage().id } });
    expect(windows.owns(win.webContents as never)).toBe(true);
    expect(windows.owns({} as never)).toBe(false);
    // The same page changing again (a save, a new title) does not open another window.
    bus.emit('page:changed', makePage({ title: 'Renamed' }));
    expect(h.state.windows).toHaveLength(1);
    expect(win.setTitle).toHaveBeenCalledWith('Renamed');
  });

  it('passes the theme to paint as ?theme=, read when each window opens, so it never shows classic first', () => {
    let theme: ThemeId = 'night';
    const { bus } = setup([], { theme: () => theme });
    bus.emit('page:changed', makePage({ id: 'A' }));
    theme = 'mint';
    bus.emit('page:changed', makePage({ id: 'B' }));
    expect(h.state.windows[0]!.loadFile).toHaveBeenCalledWith(expect.any(String), { query: { theme: 'night', page: 'A' } });
    expect(h.state.windows[1]!.loadFile).toHaveBeenCalledWith(expect.any(String), { query: { theme: 'mint', page: 'B' } });
  });

  it('cascades new windows and never opens one for a page that is not popped or is archived', () => {
    const { bus } = setup();
    bus.emit('page:changed', makePage({ id: 'A' }));
    bus.emit('page:changed', makePage({ id: 'B' }));
    bus.emit('page:changed', makePage({ id: 'C', popped: false }));
    bus.emit('page:changed', makePage({ id: 'D', archivedAt: 5 }));
    const [a, b] = h.state.windows.map((w) => w.bounds);
    expect(h.state.windows).toHaveLength(2);
    expect(b!.x).toBe(a!.x - 24);
    expect(b!.y).toBe(a!.y + 24);
  });

  it('restoreAll reopens every popped page where it was, pulled onto a visible display if its monitor is gone', () => {
    const here = { x: 300, y: 200, width: 300, height: 250, displayId: 1 };
    const gone = { x: 3000, y: 500, width: 260, height: 220, displayId: 2 };
    setup([makePage({ id: 'A', popBounds: here }), makePage({ id: 'B', popBounds: gone }), makePage({ id: 'C', popped: false })]).windows.restoreAll();
    expect(h.state.windows.map((w) => w.bounds)).toEqual([
      { x: 300, y: 200, width: 300, height: 250 },
      { x: 1920 - 260, y: 500, width: 260, height: 220 },
    ]);
  });

  it('archiving, un-popping or deleting the page closes its window, which stays openable again', () => {
    const { bus } = setup();
    bus.emit('page:changed', makePage({ id: 'A' }));
    bus.emit('page:changed', makePage({ id: 'B' }));
    bus.emit('page:changed', makePage({ id: 'C' }));
    bus.emit('page:changed', makePage({ id: 'A', popped: false, archivedAt: 9 }));
    bus.emit('page:changed', makePage({ id: 'B', popped: false }));
    bus.emit('page:deleted', { id: 'C' });
    expect(h.state.windows.map((w) => w.destroyed)).toEqual([true, true, true]);
    bus.emit('page:changed', makePage({ id: 'B' }));
    expect(h.state.windows).toHaveLength(4);
  });

  it('saves where the window is 500 ms after it stops moving or resizing', () => {
    const { bus, pages } = setup();
    bus.emit('page:changed', makePage());
    const win = h.state.windows[0]!;
    win.bounds = { x: 100, y: 120, width: 300, height: 260 };
    win.emit('move');
    vi.advanceTimersByTime(BOUNDS_SAVE_DELAY_MS - 100);
    win.emit('resize');
    vi.advanceTimersByTime(BOUNDS_SAVE_DELAY_MS - 1);
    expect(pages.setPopped).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pages.setPopped).toHaveBeenCalledExactlyOnceWith(makePage().id, true, { x: 100, y: 120, width: 300, height: 260, displayId: 1 });
  });

  it('closing the window (Alt+F4) un-pops the page like ×; quitting closes it but it stays popped', () => {
    const { bus, pages, quit } = setup();
    bus.emit('page:changed', makePage({ id: 'A' }));
    bus.emit('page:changed', makePage({ id: 'B' }));
    const [a, b] = h.state.windows;
    a!.close();
    expect(pages.setPopped).toHaveBeenCalledWith('A', false);
    expect(a!.destroyed).toBe(true);

    pages.setPopped.mockClear();
    b!.bounds = { ...b!.bounds, x: 40 };
    b!.emit('move');
    quit();
    b!.close();
    expect(b!.destroyed).toBe(true);
    // Only the position just moved to is saved, still popped.
    expect(pages.setPopped).toHaveBeenCalledExactlyOnceWith('B', true, expect.objectContaining({ x: 40 }));
  });

  it('Windows shutting down or signing out closes the windows but leaves the pages popped', () => {
    const { bus, pages } = setup();
    bus.emit('page:changed', makePage({ id: 'A' }));
    bus.emit('page:changed', makePage({ id: 'B' }));
    const [a, b] = h.state.windows;
    a!.emit('session-end');
    a!.close();
    b!.close();
    expect(h.state.windows.map((w) => w.destroyed)).toEqual([true, true]);
    expect(pages.setPopped).not.toHaveBeenCalled();
  });

  it('the corner grip resizes its own window with the cursor, never below 180 x 120, and the size is saved', () => {
    const { bus, pages } = setup();
    bus.emit('page:changed', makePage({ id: 'A' }));
    const a = h.state.windows[0]!;
    const send = (channel: string, sender: unknown = a.webContents) => h.state.ipc.get(channel)!({ sender });
    const start = { ...a.bounds };
    h.state.cursor = { x: 500, y: 500 };
    send(PageWindowChannels.resizeStart);
    h.state.cursor = { x: 560, y: 540 };
    send(PageWindowChannels.resizeMove);
    expect(a.bounds).toEqual({ ...start, width: start.width + 60, height: start.height + 40 });
    h.state.cursor = { x: 100, y: 100 };
    send(PageWindowChannels.resizeMove);
    expect(a.bounds).toEqual({ ...start, width: 180, height: 120 });
    send(PageWindowChannels.resizeEnd);
    h.state.cursor = { x: 900, y: 900 };
    send(PageWindowChannels.resizeMove);
    expect(a.bounds).toMatchObject({ width: 180, height: 120 });
    // Another window's renderer can't resize it.
    send(PageWindowChannels.resizeStart, {});
    send(PageWindowChannels.resizeMove, {});
    expect(a.bounds).toMatchObject({ width: 180, height: 120 });
    vi.advanceTimersByTime(BOUNDS_SAVE_DELAY_MS);
    expect(pages.setPopped).toHaveBeenLastCalledWith('A', true, expect.objectContaining({ width: 180, height: 120 }));
  });

  it('"—" shrinks its own window to the header and back, saving the full height meanwhile', () => {
    const { bus, pages } = setup();
    bus.emit('page:changed', makePage({ id: 'A' }));
    bus.emit('page:changed', makePage({ id: 'B' }));
    const [a, b] = h.state.windows;
    const collapse = h.state.ipc.get(PageWindowChannels.collapse)!;
    collapse({ sender: a!.webContents }, true);
    expect(a!.bounds.height).toBe(PAGE_HEADER_HEIGHT);
    expect(b!.bounds.height).toBe(220);
    vi.advanceTimersByTime(BOUNDS_SAVE_DELAY_MS);
    expect(pages.setPopped).toHaveBeenLastCalledWith('A', true, expect.objectContaining({ height: 220 }));
    collapse({ sender: a!.webContents }, false);
    expect(a!.bounds.height).toBe(220);
    collapse({ sender: {} }, true);
    expect(h.state.windows.map((w) => w.bounds.height)).toEqual([220, 220]);
  });
});
