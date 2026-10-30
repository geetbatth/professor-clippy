/**
 * Tray icon (Show / Mute / Quit). The icon is the app icon's art (Professor Clippy's goggles and
 * mortarboard peeking over a sticky note) at 16 DIP, one PNG per display scale, generated into
 * trayIconImages.ts by scripts/make-icons.mjs, so there's no image asset to package.
 */
import { Menu, nativeImage, Tray, type NativeImage } from 'electron';
import { TRAY_ICON_IMAGES } from './trayIconImages';

export function trayIcon(): NativeImage {
  const image = nativeImage.createEmpty();
  for (const { scaleFactor, dataURL } of TRAY_ICON_IMAGES) image.addRepresentation({ scaleFactor, dataURL });
  return image;
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
