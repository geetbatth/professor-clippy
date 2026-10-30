/**
 * Pure window geometry: where mini/expanded Clippy go, kept on a visible display.
 * No Electron imports, so it is unit-testable.
 */
import type { WindowPos } from '@clippy/shared/settings';
import { WINDOW_SIZES } from './windowApi';

export interface Point {
  x: number;
  y: number;
}
export interface Rect extends Point {
  width: number;
  height: number;
}
/** The bits of an Electron `Display` we use. */
export interface DisplayArea {
  id: number;
  workArea: Rect;
}

/** Gap from the screen edge for the default corner position. */
export const EDGE_MARGIN = 16;

/** Move (never resize) `rect` so it lies inside `area` (top-left wins if it is too big). */
export function clampToArea(rect: Rect, area: Rect): Rect {
  const maxX = area.x + area.width - rect.width;
  const maxY = area.y + area.height - rect.height;
  return {
    ...rect,
    x: Math.round(Math.max(area.x, Math.min(rect.x, maxX))),
    y: Math.round(Math.max(area.y, Math.min(rect.y, maxY))),
  };
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

function centreDistance(a: Rect, b: Rect): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

/** The display showing most of `rect`; if it is off every display, the nearest one. */
export function pickDisplay(rect: Rect, displays: readonly DisplayArea[]): DisplayArea {
  if (displays.length === 0) throw new Error('No displays');
  let best = displays[0]!;
  let bestOverlap = -1;
  for (const d of displays) {
    const o = overlapArea(rect, d.workArea);
    if (o > bestOverlap) {
      best = d;
      bestOverlap = o;
    }
  }
  if (bestOverlap > 0) return best;
  return displays.reduce((a, b) => (centreDistance(rect, b.workArea) < centreDistance(rect, a.workArea) ? b : a));
}

/** Bottom-right corner of a work area, where a fresh mini Clippy lives. */
export function defaultMiniPos(area: Rect): Point {
  const { width, height } = WINDOW_SIZES.mini;
  return { x: area.x + area.width - width - EDGE_MARGIN, y: area.y + area.height - height - EDGE_MARGIN };
}

/**
 * Where mini Clippy starts: the saved position clamped onto a visible display,
 * or the primary display's bottom-right corner when nothing is saved.
 */
export function resolveMiniPos(
  saved: WindowPos | undefined,
  displays: readonly DisplayArea[],
  primary: DisplayArea,
): WindowPos {
  if (!saved) return { ...defaultMiniPos(primary.workArea), displayId: primary.id };
  const rect = { x: saved.x, y: saved.y, ...WINDOW_SIZES.mini };
  // Prefer the saved display if it is still attached; otherwise whichever display is closest.
  const display = displays.find((d) => d.id === saved.displayId) ?? pickDisplay(rect, displays);
  const clamped = clampToArea(rect, display.workArea);
  return { x: clamped.x, y: clamped.y, displayId: display.id };
}

/**
 * Expanded bounds for a mini window at `mini`: top-right corners line up, so Clippy
 * stays put (he sits in the expanded layout's top-right corner), then clamped.
 */
export function expandedFromMini(mini: Point, area: Rect): Rect {
  const e = WINDOW_SIZES.expanded;
  const m = WINDOW_SIZES.mini;
  return clampToArea({ x: mini.x + m.width - e.width, y: mini.y, ...e }, area);
}

/** Inverse of {@link expandedFromMini}: where mini Clippy goes when an expanded window collapses. */
export function miniFromExpanded(expanded: Point, area: Rect): Point {
  const e = WINDOW_SIZES.expanded;
  const m = WINDOW_SIZES.mini;
  const r = clampToArea({ x: expanded.x + e.width - m.width, y: expanded.y, ...m }, area);
  return { x: r.x, y: r.y };
}
