/**
 * The always-on-top, frameless, transparent Professor Clippy window.
 *
 * - Two sizes (`WINDOW_SIZES`), switched by the renderer over `window:mode`.
 * - Dragged from a renderer drag handle (`window:drag*`); main moves the window to follow the cursor.
 * - Position (of mini Clippy) is loaded/saved through injected `loadPos`/`savePos`, clamped to a visible display.
 * - Transparent areas let clicks through: it starts ignoring the mouse (with forwarding,
 *   so the renderer still sees moves) and the renderer flips that off over opaque parts.
 * - Hidden while another app is fullscreen, if `hideOnFullscreen()`.
 */
import { join } from 'node:path';
import { app, BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron';
import type { WindowPos } from '@clippy/shared/settings';
import { createFullscreenGate, windowsFullscreenProbe, type FullscreenProbe } from './fullscreen';
import {
  clampToArea,
  expandedFromMini,
  miniFromExpanded,
  pickDisplay,
  resolveMiniPos,
  type DisplayArea,
  type Point,
  type Rect,
} from './geometry';
import { isWindowMode, WINDOW_SIZES, WindowChannels, type CursorPoint, type WindowMode } from './windowApi';

export interface ClippyWindowOptions {
  /** Saved mini-Clippy position (e.g. `settings.windowPos`), or undefined for the default corner. */
  loadPos: () => WindowPos | undefined;
  /** Persist mini Clippy's position after a drag (e.g. `setSettings({ windowPos })`). */
  savePos: (pos: WindowPos) => void;
  /** Read on every fullscreen poll, so a settings change applies within a couple of seconds. */
  hideOnFullscreen: () => boolean;
  /** Fullscreen detector; defaults to the Windows PowerShell probe. */
  fullscreenProbe?: FullscreenProbe;
  /** Defaults to `<dir of the main bundle>/../preload/index.cjs`. */
  preloadPath?: string;
  /** Dev server URL; defaults to `ELECTRON_RENDERER_URL` when not packaged. */
  rendererUrl?: string;
  /** Built renderer; defaults to `<dir of the main bundle>/../renderer/index.html`. */
  rendererFile?: string;
  /** Extra renderer query parameters (e.g. `{ mock: '1' }` for a demo). */
  query?: Record<string, string>;
}

export interface ClippyWindow {
  win: BrowserWindow;
  getMode(): WindowMode;
  /** Change mode from main (tray, second instance); the renderer is told via `window:modeChanged`. */
  setMode(mode: WindowMode): void;
}

/** How often the global cursor is sampled for Clippy's eyes. */
const CURSOR_POLL_MS = 50;

function allDisplays(): DisplayArea[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }));
}

function primaryDisplay(): DisplayArea {
  const p = screen.getPrimaryDisplay();
  return { id: p.id, workArea: p.workArea };
}

export function createClippyWindow(opts: ClippyWindowOptions): ClippyWindow {
  let anchor = resolveMiniPos(opts.loadPos(), allDisplays(), primaryDisplay());
  let mode: WindowMode = 'mini';

  const win = new BrowserWindow({
    x: anchor.x,
    y: anchor.y,
    ...WINDOW_SIZES.mini,
    title: 'Professor Clippy',
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: opts.preloadPath ?? join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Clippy's sound effects play without a click first.
      autoplayPolicy: 'no-user-gesture-required',
      // Mood timers keep running while the window is covered.
      backgroundThrottling: false,
    },
  });
  const contents = win.webContents;
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true, { forward: true });
  win.once('ready-to-show', () => win.showInactive());

  // Agent text is rendered as plain text, but never let the page navigate or open windows anyway.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-navigate', (e) => e.preventDefault());

  const miniRect = (p: Point): Rect => ({ x: p.x, y: p.y, ...WINDOW_SIZES.mini });

  function boundsFor(m: WindowMode): Rect {
    const area = pickDisplay(miniRect(anchor), allDisplays()).workArea;
    return m === 'mini' ? clampToArea(miniRect(anchor), area) : expandedFromMini(anchor, area);
  }

  function applyMode(m: WindowMode): void {
    mode = m;
    win.setBounds(boundsFor(m));
  }

  function setAnchor(p: Point): void {
    const displayId = pickDisplay(miniRect(p), allDisplays()).id;
    if (p.x === anchor.x && p.y === anchor.y && displayId === anchor.displayId) return;
    anchor = { x: p.x, y: p.y, displayId };
    opts.savePos(anchor);
  }

  // ---- renderer -> main window controls (accepted only from this window's page) ----
  let drag: { cursor: Point; bounds: Rect } | undefined;
  const handlers: Record<string, (...args: unknown[]) => void> = {
    [WindowChannels.mode]: (m) => {
      if (isWindowMode(m) && m !== mode) applyMode(m);
    },
    [WindowChannels.ignoreMouse]: (ignore) => {
      if (ignore === true) win.setIgnoreMouseEvents(true, { forward: true });
      else if (ignore === false) win.setIgnoreMouseEvents(false);
    },
    [WindowChannels.dragStart]: () => {
      drag = { cursor: screen.getCursorScreenPoint(), bounds: { ...win.getBounds(), ...WINDOW_SIZES[mode] } };
    },
    [WindowChannels.dragMove]: () => {
      if (!drag) return;
      const c = screen.getCursorScreenPoint();
      // setBounds (not setPosition) so a move across mixed-DPI displays never changes the size.
      win.setBounds({ ...drag.bounds, x: drag.bounds.x + c.x - drag.cursor.x, y: drag.bounds.y + c.y - drag.cursor.y });
    },
    [WindowChannels.dragEnd]: () => {
      if (!drag) return;
      drag = undefined;
      const b = { ...win.getBounds(), ...WINDOW_SIZES[mode] };
      const area = pickDisplay(b, allDisplays()).workArea;
      const clamped = clampToArea(b, area);
      win.setBounds(clamped);
      setAnchor(mode === 'mini' ? clamped : miniFromExpanded(clamped, area));
    },
  };
  const listeners = Object.entries(handlers).map(([channel, handler]) => {
    const listener = (e: IpcMainEvent, ...args: unknown[]) => {
      if (e.sender === contents) handler(...args);
    };
    ipcMain.on(channel, listener);
    return [channel, listener] as const;
  });

  // ---- global cursor for the googly eyes ----
  let lastCursor: CursorPoint | undefined;
  const cursorTimer = setInterval(() => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const c = screen.getCursorScreenPoint();
    const b = win.getContentBounds();
    const point = { x: c.x - b.x, y: c.y - b.y };
    if (lastCursor && lastCursor.x === point.x && lastCursor.y === point.y) return;
    lastCursor = point;
    contents.send(WindowChannels.cursor, point);
  }, CURSOR_POLL_MS);

  // ---- keep Clippy on a visible display when monitors change ----
  const onDisplaysChanged = () => {
    if (win.isDestroyed()) return;
    setAnchor(resolveMiniPos(anchor, allDisplays(), primaryDisplay()));
    applyMode(mode);
  };
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  // ---- hide while another app is fullscreen ----
  const probe = opts.fullscreenProbe ?? windowsFullscreenProbe();
  probe.start(
    createFullscreenGate({
      enabled: opts.hideOnFullscreen,
      hide: () => {
        if (!win.isDestroyed()) win.hide();
      },
      show: () => {
        if (!win.isDestroyed()) win.showInactive();
      },
    }),
  );

  win.on('closed', () => {
    clearInterval(cursorTimer);
    probe.stop();
    screen.removeListener('display-removed', onDisplaysChanged);
    screen.removeListener('display-metrics-changed', onDisplaysChanged);
    for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
  });

  // ---- load the renderer ----
  const devUrl = opts.rendererUrl ?? (!app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined);
  const query = opts.query ?? {};
  if (devUrl) {
    const url = new URL(devUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(opts.rendererFile ?? join(import.meta.dirname, '../renderer/index.html'), { query });
  }

  return {
    win,
    getMode: () => mode,
    setMode(m) {
      if (m !== mode) applyMode(m);
      contents.send(WindowChannels.modeChanged, m);
    },
  };
}
