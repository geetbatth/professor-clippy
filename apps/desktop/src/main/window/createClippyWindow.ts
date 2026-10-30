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
import { createFullscreenWatcher, windowsProbe, type SpawnProbe } from './fullscreen';
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
  /** Re-read every few seconds: the fullscreen probe only runs while this is true. */
  hideOnFullscreen: () => boolean;
  /** Fullscreen probe; defaults to the Windows probe on win32 (none elsewhere). `null` disables it. */
  fullscreenProbe?: SpawnProbe | null;
  /** Diagnostics (probe restarts / giving up). Defaults to console.warn. */
  log?: (message: string) => void;
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

/** How often the global cursor is sampled (Clippy leans towards it). */
const CURSOR_POLL_MS = 50;

function allDisplays(): DisplayArea[] {
  return screen.getAllDisplays().map((d) => ({ id: d.id, workArea: d.workArea }));
}

function primaryDisplay(): DisplayArea {
  const p = screen.getPrimaryDisplay();
  return { id: p.id, workArea: p.workArea };
}

const miniRect = (p: Point): Rect => ({ x: p.x, y: p.y, ...WINDOW_SIZES.mini });

export function createClippyWindow(opts: ClippyWindowOptions): ClippyWindow {
  // Mini Clippy's top-left as the user left it. Window bounds are always clamped from it onto a
  // visible display, but it is only rewritten (and saved) when the user drags him.
  let anchor: WindowPos = opts.loadPos() ?? resolveMiniPos(undefined, allDisplays(), primaryDisplay());
  let mode: WindowMode = 'mini';

  /** Work area for the anchor: its saved display if still attached, else whichever is closest. */
  function anchorArea(): Rect {
    const displays = allDisplays();
    return (displays.find((d) => d.id === anchor.displayId) ?? pickDisplay(miniRect(anchor), displays)).workArea;
  }
  const initial = clampToArea(miniRect(anchor), anchorArea());

  const win = new BrowserWindow({
    ...initial,
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

  function boundsFor(m: WindowMode): Rect {
    const area = anchorArea();
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
  let drag: { cursor: Point; bounds: Rect; moved: boolean } | undefined;
  const handlers: Record<string, (...args: unknown[]) => void> = {
    [WindowChannels.mode]: (m) => {
      if (isWindowMode(m) && m !== mode) applyMode(m);
    },
    [WindowChannels.ignoreMouse]: (ignore) => {
      if (ignore === true) win.setIgnoreMouseEvents(true, { forward: true });
      else if (ignore === false) win.setIgnoreMouseEvents(false);
    },
    [WindowChannels.dragStart]: () => {
      drag = { cursor: screen.getCursorScreenPoint(), bounds: { ...win.getBounds(), ...WINDOW_SIZES[mode] }, moved: false };
    },
    [WindowChannels.dragMove]: () => {
      if (!drag) return;
      const c = screen.getCursorScreenPoint();
      if (c.x === drag.cursor.x && c.y === drag.cursor.y && !drag.moved) return;
      drag.moved = true;
      // setBounds (not setPosition) so a move across mixed-DPI displays never changes the size.
      win.setBounds({ ...drag.bounds, x: drag.bounds.x + c.x - drag.cursor.x, y: drag.bounds.y + c.y - drag.cursor.y });
    },
    [WindowChannels.dragEnd]: () => {
      if (!drag) return;
      const { moved } = drag;
      drag = undefined;
      // A click is not a move: don't persist (or clamp) anything.
      if (!moved) return;
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

  // ---- global cursor, so Clippy can lean towards it ----
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
  // Only the window is clamped; the saved anchor is the user's choice and is never rewritten
  // here, so plugging the monitor back in puts Clippy back where they left him.
  const onDisplaysChanged = () => {
    if (!win.isDestroyed()) applyMode(mode);
  };
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);

  // ---- hide while another app is fullscreen ----
  const spawnProbe = opts.fullscreenProbe === undefined ? (process.platform === 'win32' ? windowsProbe() : null) : opts.fullscreenProbe;
  const fullscreen = spawnProbe
    ? createFullscreenWatcher({
        spawn: spawnProbe,
        enabled: opts.hideOnFullscreen,
        log: opts.log ?? ((m) => console.warn(m)),
        hide: () => {
          if (!win.isDestroyed()) win.hide();
        },
        show: () => {
          if (!win.isDestroyed()) win.showInactive();
        },
      })
    : undefined;
  fullscreen?.start();

  win.on('closed', () => {
    clearInterval(cursorTimer);
    fullscreen?.stop();
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
