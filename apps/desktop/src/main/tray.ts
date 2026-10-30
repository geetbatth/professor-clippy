/**
 * Tray icon (Show / Mute / Quit). The icon is drawn in code, a small paperclip on a yellow
 * sticky note, so there's no image asset to package.
 */
import { Menu, nativeImage, Tray, type NativeImage } from 'electron';

const SIZE = 32;

/** Signed distance from (px, py) to a vertical capsule centred on x = cx from y1 to y2, radius r. */
function capsule(px: number, py: number, cx: number, y1: number, y2: number, r: number): number {
  const y = Math.min(Math.max(py, y1), y2);
  return Math.hypot(px - cx, py - y) - r;
}

/** BGRA pixels of the 32×32 tray icon (pure, for tests). */
export function trayIconPixels(): Buffer {
  const buf = Buffer.alloc(SIZE * SIZE * 4);
  const put = (i: number, rgb: readonly [number, number, number], a: number) => {
    // Composite over what is already there.
    const da = buf[i + 3]! / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) return;
    for (let c = 0; c < 3; c++) {
      const src = rgb[2 - c]!; // BGRA order
      buf[i + c] = Math.round((src * a + buf[i + c]! * da * (1 - a)) / oa);
    }
    buf[i + 3] = Math.round(oa * 255);
  };
  const note = [255, 214, 74] as const;
  const wire = [70, 82, 96] as const;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      const px = x + 0.5;
      const py = y + 0.5;
      // Sticky note: a square with a little margin.
      if (px > 4 && px < 28 && py > 6 && py < 30) put(i, note, 1);
      // Paperclip: two nested capsule outlines, the inner one open at the bottom.
      const stroke = 1.1;
      const outer = Math.abs(capsule(px, py, 16, 6, 21, 6.5)) - stroke;
      const inner = py < 24 ? Math.abs(capsule(px, py, 16, 9, 18, 3.5)) - stroke : 1;
      const d = Math.min(outer, inner);
      const a = Math.min(1, Math.max(0, 0.5 - d));
      if (a > 0) put(i, wire, a);
    }
  }
  return buf;
}

export function trayIcon(): NativeImage {
  return nativeImage.createFromBitmap(trayIconPixels(), { width: SIZE, height: SIZE, scaleFactor: 2 });
}

export interface TrayActions {
  onShow(): void;
  onToggleMute(): void;
  onQuit(): void;
  muted(): boolean;
}

export interface ClippyTray {
  /** Rebuild the menu (e.g. after the mute setting changed). */
  refresh(): void;
  destroy(): void;
}

export function createTray(actions: TrayActions): ClippyTray {
  const tray = new Tray(trayIcon());
  tray.setToolTip('Professor Clippy');
  const refresh = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Show Clippy', click: () => actions.onShow() },
        { label: 'Mute sounds', type: 'checkbox', checked: actions.muted(), click: () => actions.onToggleMute() },
        { type: 'separator' },
        { label: 'Quit Professor Clippy', click: () => actions.onQuit() },
      ]),
    );
  refresh();
  tray.on('click', () => actions.onShow());
  return { refresh, destroy: () => tray.destroy() };
}
