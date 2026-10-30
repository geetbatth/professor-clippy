/**
 * The sprite images: their URLs, startup preloading, and alpha masks for click-through.
 * Every sprite is fetched and decoded once at startup, so pose swaps never flicker.
 */
import asleep from './sprites/asleep.webp';
import blink from './sprites/blink.webp';
import celebrate from './sprites/celebrate.webp';
import idle from './sprites/idle.webp';
import knock from './sprites/knock.webp';
import mini from './sprites/mini.webp';
import newNote from './sprites/new-note.webp';
import thinking from './sprites/thinking.webp';
import urgent from './sprites/urgent.webp';
import { buildMask, type AlphaMask } from './alphaMask';
import { POSES, type Pose } from './poses';

export const SPRITE_URLS: Readonly<Record<Pose, string>> = {
  idle,
  blink,
  thinking,
  asleep,
  'new-note': newNote,
  urgent,
  celebrate,
  knock,
  mini,
};

/** Mask cell size in sprite pixels (about one CSS pixel at the window's scale). */
const MASK_CELL = 4;

/** Kept alive so the decoded images stay in the memory cache. */
const images: HTMLImageElement[] = [];
const masks = new Map<Pose, AlphaMask>();
let loading: Promise<void> | undefined;

function maskOf(img: HTMLImageElement): AlphaMask | undefined {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) return undefined;
    g.drawImage(img, 0, 0);
    return buildMask(g.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, MASK_CELL);
  } catch {
    // A tainted canvas (shouldn't happen: the sprites are same-origin): fall back to the box.
    return undefined;
  }
}

/** Fetch and decode every sprite once (idempotent), then build their click-through masks. */
export function preloadSprites(): Promise<void> {
  loading ??= Promise.all(
    POSES.map(async (pose) => {
      const img = new Image();
      img.src = SPRITE_URLS[pose];
      images.push(img);
      try {
        await img.decode();
      } catch {
        return; // a broken image just shows nothing; its whole box stays clickable
      }
      const mask = maskOf(img);
      if (mask) masks.set(pose, mask);
    }),
  ).then(() => undefined);
  return loading;
}

/** The alpha mask for `pose`, once preloaded (undefined before, or if it couldn't be read). */
export function spriteMask(pose: Pose): AlphaMask | undefined {
  return masks.get(pose);
}
