/**
 * Tells every window when Windows switches between light and dark, so "Follow Windows dark
 * mode" takes effect at once (the renderer picks the theme with `resolveTheme`).
 *
 * Electron-free (the pieces it needs are passed in), so it is testable.
 */
import { IpcEvents } from '@clippy/shared/ipc';

/** The part of Electron's `nativeTheme` this needs. */
export interface NativeThemeLike {
  readonly shouldUseDarkColors: boolean;
  on(event: 'updated', listener: () => void): unknown;
  off(event: 'updated', listener: () => void): unknown;
}

/** The part of a `BrowserWindow` this needs. */
export interface ThemeWindow {
  isDestroyed(): boolean;
  webContents: { send(channel: string, ...args: unknown[]): void; isDestroyed(): boolean };
}

/**
 * Send `theme:system` (`true` = dark) to every live window each time Windows switches.
 * `windows` is read at that moment, so windows opened later are included. Returns a function
 * that stops forwarding.
 */
export function forwardSystemTheme(native: NativeThemeLike, windows: () => readonly ThemeWindow[]): () => void {
  const onUpdated = () => {
    const dark = native.shouldUseDarkColors;
    for (const win of windows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(IpcEvents.themeSystem, dark);
    }
  };
  native.on('updated', onUpdated);
  return () => void native.off('updated', onUpdated);
}
