/**
 * Window-shell contract between the Clippy window (main), the preload and the renderer.
 *
 * These channels are desktop-internal (they move/resize the window), so they live here
 * rather than in `@clippy/shared`. This module is constants + types only, so the
 * sandboxed preload and the renderer can import it.
 */

/** Mini = just Clippy (and the unread badge); expanded = Clippy standing on the sticky note. */
export type WindowMode = 'mini' | 'expanded';

export const WINDOW_MODES: readonly WindowMode[] = ['mini', 'expanded'];

/**
 * Window content size per mode, in DIPs. The renderer lays out to fill the window. The mini
 * window is exactly Clippy's stage (`STAGE` in clippy/poses.ts, same aspect ratio); expanded puts
 * that stage in its top-right corner, standing on the note.
 */
export const WINDOW_SIZES: Readonly<Record<WindowMode, { width: number; height: number }>> = {
  mini: { width: 156, height: 192 },
  expanded: { width: 380, height: 640 },
};

/** Renderer → main (`ipcRenderer.send`) and main → renderer (`webContents.send`) channels. */
export const WindowChannels = {
  /** renderer → main: switch size (`WindowMode`). */
  mode: 'window:mode',
  /** main → renderer: the window mode was changed from main (tray, second instance...). */
  modeChanged: 'window:modeChanged',
  /** renderer → main: `true` = let clicks through (transparent area), `false` = capture (opaque part). */
  ignoreMouse: 'window:ignoreMouse',
  /** renderer → main: drag handle grabbed / moved / released. Main reads the cursor itself. */
  dragStart: 'window:dragStart',
  dragMove: 'window:dragMove',
  dragEnd: 'window:dragEnd',
  /** main → renderer: global cursor position relative to the window's top-left (`CursorPoint`). */
  cursor: 'window:cursor',
  /** main -> renderer: the global hotkey was pressed; open Notes and focus the Tell Clippy box. */
  tell: 'window:tell',
  /** renderer -> main: give keyboard focus back (the box is done; the window never keeps it). */
  blur: 'window:blur',
} as const;

export interface CursorPoint {
  x: number;
  y: number;
}

/** What the preload exposes as `window.clippyWindow`. */
export interface ClippyWindowShell {
  setMode(mode: WindowMode): void;
  setIgnoreMouse(ignore: boolean): void;
  dragStart(): void;
  dragMove(): void;
  dragEnd(): void;
  /** Cursor anywhere on screen, relative to the window. Returns an unsubscribe function. */
  onCursor(cb: (point: CursorPoint) => void): () => void;
  /** Mode changed by main. Returns an unsubscribe function. */
  onModeChanged(cb: (mode: WindowMode) => void): () => void;
  /** The Tell Clippy hotkey was pressed. Returns an unsubscribe function. */
  onTell(cb: () => void): () => void;
  /** Hand keyboard focus back to whatever app had it. */
  blur(): void;
}

export function isWindowMode(value: unknown): value is WindowMode {
  return value === 'mini' || value === 'expanded';
}

/** Height of a popped-out page window's header, in DIPs: what is left when it is collapsed. */
export const PAGE_HEADER_HEIGHT = 30;

/** Renderer → main channels of a popped-out page's window. */
export const PageWindowChannels = {
  /** renderer → main: `true` = shrink to the header ("—"), `false` = back to full size. */
  collapse: 'pageWindow:collapse',
  /**
   * renderer → main: the resize grip was grabbed / moved / released; main reads the cursor
   * itself. (Windows gives transparent windows no resizable border, so the sticky has a grip.)
   */
  resizeStart: 'pageWindow:resizeStart',
  resizeMove: 'pageWindow:resizeMove',
  resizeEnd: 'pageWindow:resizeEnd',
} as const;

/** What the preload exposes as `window.clippyPageWindow` (only a page window acts on it). */
export interface PageWindowShell {
  setCollapsed(collapsed: boolean): void;
  resizeStart(): void;
  resizeMove(): void;
  resizeEnd(): void;
}
