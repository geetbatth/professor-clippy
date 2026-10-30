import { describe, expect, it } from 'vitest';
import type { DisplayArea, Rect } from '../../src/main/window/geometry';
import { CASCADE_STEP, clampBounds, defaultPageBounds, PAGE_WINDOW_SIZE } from '../../src/main/window/pageBounds';

// Primary 1920x1080 (taskbar 40px) listed first, plus a second monitor to the right.
const primary: DisplayArea = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const right: DisplayArea = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };

const inside = (r: Rect, area: Rect) =>
  r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;

describe('clampBounds', () => {
  it('a page left on a monitor that is no longer attached reopens fully inside the primary work area', () => {
    const onGone = { x: 3000, y: 900, width: 260, height: 220, displayId: 2 };
    const out = clampBounds(onGone, [primary]);
    expect(inside(out, primary.workArea)).toBe(true);
    expect(out).toMatchObject({ width: 260, height: 220, displayId: 1 });
    // Same with the id of a display that never existed, and with the primary not at 0,0.
    const offset: DisplayArea = { id: 7, workArea: { x: -1280, y: 200, width: 1280, height: 984 } };
    const out2 = clampBounds({ x: 50, y: 50, width: 300, height: 400, displayId: 99 }, [offset, primary]);
    expect(inside(out2, offset.workArea)).toBe(true);
    expect(out2).toMatchObject({ width: 300, height: 400, displayId: 7 });
  });

  it('pulls in a page that is half off the right edge, keeping its size', () => {
    const half = { x: 1920 - 130, y: 300, width: 260, height: 220, displayId: 1 };
    expect(clampBounds(half, [primary])).toEqual({ x: 1920 - 260, y: 300, width: 260, height: 220, displayId: 1 });
  });

  it('leaves a fully visible page alone, also one spanning two monitors', () => {
    const shown = { x: 400, y: 300, width: 260, height: 220, displayId: 1 };
    expect(clampBounds(shown, [primary, right])).toEqual(shown);
    const spanning = { x: 1800, y: 300, width: 260, height: 220, displayId: 1 };
    expect(clampBounds(spanning, [primary, right])).toEqual(spanning);
  });

  it('leaves a page that is at least 80 % visible alone', () => {
    const mostly = { x: 1920 - 208, y: 300, width: 260, height: 220, displayId: 1 }; // 80 % on screen
    expect(clampBounds(mostly, [primary])).toEqual(mostly);
    const less = { x: 1920 - 207, y: 300, width: 260, height: 220, displayId: 1 };
    expect(clampBounds(less, [primary]).x).toBe(1920 - 260);
  });

  it('pulls a page in on its own monitor when that one is still attached', () => {
    const offRight = { x: 1920 + 2560 - 100, y: 600, width: 260, height: 220, displayId: 2 };
    const out = clampBounds(offRight, [primary, right]);
    expect(out).toEqual({ x: 1920 + 2560 - 260, y: 600, width: 260, height: 220, displayId: 2 });
  });

  it('shrinks a page bigger than the work area to fit it', () => {
    const huge = { x: 2000, y: -50, width: 3000, height: 1600, displayId: 2 };
    expect(clampBounds(huge, [primary])).toEqual({ x: 0, y: 0, width: 1920, height: 1040, displayId: 1 });
  });

  it('with no displays at all, gives the bounds back', () => {
    const b = { x: 5, y: 5, width: 260, height: 220, displayId: 3 };
    expect(clampBounds(b, [])).toEqual(b);
  });
});

describe('defaultPageBounds', () => {
  it('starts 260 x 220 near the top-right of the work area, inside it', () => {
    const first = defaultPageBounds(0, primary.workArea);
    expect(PAGE_WINDOW_SIZE).toEqual({ width: 260, height: 220 });
    expect(first).toEqual({ x: 1920 - 260 - CASCADE_STEP, y: CASCADE_STEP, width: 260, height: 220 });
    expect(inside(first, primary.workArea)).toBe(true);
  });

  it('cascades the 2nd window 24 px from the 1st', () => {
    const first = defaultPageBounds(0, primary.workArea);
    const second = defaultPageBounds(1, primary.workArea);
    expect(CASCADE_STEP).toBe(24);
    expect(second.x).toBe(first.x - 24);
    expect(second.y).toBe(first.y + 24);
    expect(second).toMatchObject({ width: 260, height: 220 });
  });

  it('starts over at the top once the cascade would run off the bottom', () => {
    const small = { x: 0, y: 0, width: 800, height: 400 };
    for (let i = 0; i < 30; i++) expect(inside(defaultPageBounds(i, small), small)).toBe(true);
    expect(defaultPageBounds(7, small)).toEqual(defaultPageBounds(0, small));
  });
});
