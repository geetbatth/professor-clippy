/**
 * Pure geometry for popped-out Pad pages: where a new page window goes, and keeping a saved one
 * on a visible display (a monitor may have been unplugged since). No Electron imports.
 */
import { clampToArea, type DisplayArea, type Rect } from './geometry';

/** A new page window's size, in DIPs. */
export const PAGE_WINDOW_SIZE = { width: 260, height: 220 } as const;
/** The smallest a page window can be resized to. */
export const PAGE_WINDOW_MIN = { width: 180, height: 120 } as const;
/** New page windows start this far from the top-right corner, and each further one this much down and left. */
export const CASCADE_STEP = 24;
/** A saved window less visible than this (as a share of its area) is pulled back on screen. */
export const MIN_VISIBLE = 0.8;

/** Where a page window is: its bounds and the display it was on. */
export interface PageWindowBounds extends Rect {
  displayId: number;
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * A saved page window's bounds made safe to open. `displays` lists the primary display first.
 * - At least {@link MIN_VISIBLE} visible (counting every display, so a window across two monitors
 *   is fine): unchanged. If its display id is gone (Windows renumbers displays), it takes the id
 *   of the display it overlaps most.
 * - Less visible but its display still attached: pulled in onto that display.
 * - Less visible and its display is gone: moved onto the primary display's work area.
 * The size is kept, shrunk only if it is bigger than the work area.
 */
export function clampBounds(bounds: PageWindowBounds, displays: readonly DisplayArea[]): PageWindowBounds {
  const primary = displays[0];
  if (!primary) return bounds;
  const own = displays.find((d) => d.id === bounds.displayId);
  const visible = displays.reduce((sum, d) => sum + overlap(bounds, d.workArea), 0);
  if (visible >= MIN_VISIBLE * bounds.width * bounds.height) {
    if (own) return bounds;
    const most = displays.reduce((best, d) => (overlap(bounds, d.workArea) > overlap(bounds, best.workArea) ? d : best));
    return { ...bounds, displayId: most.id };
  }
  const target = own ?? primary;
  const area = target.workArea;
  const size = { width: Math.min(bounds.width, area.width), height: Math.min(bounds.height, area.height) };
  return { ...clampToArea({ x: bounds.x, y: bounds.y, ...size }, area), displayId: target.id };
}

/**
 * Where the `index`-th page window opened without saved bounds goes: {@link PAGE_WINDOW_SIZE},
 * {@link CASCADE_STEP} in from the work area's top-right corner, each next one a step down and
 * left, starting over at the top once the next would not fit.
 */
export function defaultPageBounds(index: number, workArea: Rect): Rect {
  const { width, height } = PAGE_WINDOW_SIZE;
  const fit = (room: number, size: number) => Math.floor((room - size - CASCADE_STEP) / CASCADE_STEP) + 1;
  const steps = Math.max(1, Math.min(fit(workArea.height, height), fit(workArea.width, width)));
  const i = Math.max(0, Math.floor(index)) % steps;
  const x = workArea.x + workArea.width - width - CASCADE_STEP * (i + 1);
  const y = workArea.y + CASCADE_STEP * (i + 1);
  return clampToArea({ x, y, width, height }, workArea);
}
