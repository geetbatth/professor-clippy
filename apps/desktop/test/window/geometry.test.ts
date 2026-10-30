import { describe, expect, it } from 'vitest';
import {
  clampToArea,
  defaultMiniPos,
  EDGE_MARGIN,
  expandedFromMini,
  miniFromExpanded,
  pickDisplay,
  resolveMiniPos,
  type DisplayArea,
} from '../../src/main/window/geometry';
import { WINDOW_SIZES } from '../../src/main/window/windowApi';

// Primary 1920x1080 (taskbar 40px), plus a second monitor to the right.
const primary: DisplayArea = { id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } };
const right: DisplayArea = { id: 2, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } };
const displays = [primary, right];
const { mini, expanded } = WINDOW_SIZES;

describe('clampToArea', () => {
  it('leaves an inside rect alone and pulls an outside one back in', () => {
    const area = primary.workArea;
    expect(clampToArea({ x: 100, y: 100, width: 10, height: 10 }, area)).toMatchObject({ x: 100, y: 100 });
    expect(clampToArea({ x: -50, y: 2000, width: 140, height: 160 }, area)).toEqual({ x: 0, y: 880, width: 140, height: 160 });
    expect(clampToArea({ x: 1900, y: -10, width: 140, height: 160 }, area)).toMatchObject({ x: 1780, y: 0 });
  });
});

describe('pickDisplay', () => {
  it('picks the display with the most overlap', () => {
    expect(pickDisplay({ x: 1900, y: 10, width: 140, height: 160 }, displays).id).toBe(2);
    expect(pickDisplay({ x: 1850, y: 10, width: 140, height: 160 }, displays).id).toBe(1);
  });
  it('picks the nearest display when the rect is off-screen', () => {
    expect(pickDisplay({ x: 9000, y: 100, width: 140, height: 160 }, displays).id).toBe(2);
    expect(pickDisplay({ x: -3000, y: 100, width: 140, height: 160 }, displays).id).toBe(1);
  });
});

describe('resolveMiniPos', () => {
  it('defaults to the bottom-right corner of the primary display', () => {
    const pos = resolveMiniPos(undefined, displays, primary);
    expect(pos).toEqual({
      x: 1920 - mini.width - EDGE_MARGIN,
      y: 1040 - mini.height - EDGE_MARGIN,
      displayId: 1,
    });
    expect(defaultMiniPos(primary.workArea)).toEqual({ x: pos.x, y: pos.y });
  });

  it('keeps a valid saved position', () => {
    expect(resolveMiniPos({ x: 2500, y: 300, displayId: 2 }, displays, primary)).toEqual({ x: 2500, y: 300, displayId: 2 });
  });

  it('clamps a position that hangs off its display', () => {
    expect(resolveMiniPos({ x: 4470, y: 1390, displayId: 2 }, displays, primary)).toEqual({
      x: 1920 + 2560 - mini.width,
      y: 1400 - mini.height,
      displayId: 2,
    });
  });

  it('moves to a remaining display when the saved one was unplugged', () => {
    expect(resolveMiniPos({ x: 2500, y: 300, displayId: 2 }, [primary], primary)).toEqual({
      x: 1920 - mini.width,
      y: 300,
      displayId: 1,
    });
  });
});

describe('expand / collapse', () => {
  it('lines up the top-right corners so Clippy stays put', () => {
    const e = expandedFromMini({ x: 1000, y: 100 }, primary.workArea);
    expect(e).toEqual({ x: 1000 + mini.width - expanded.width, y: 100, ...expanded });
    expect(miniFromExpanded(e, primary.workArea)).toEqual({ x: 1000, y: 100 });
  });

  it('pushes the expanded note back on screen from the bottom-right corner', () => {
    const corner = defaultMiniPos(primary.workArea);
    const e = expandedFromMini(corner, primary.workArea);
    expect(e.x + e.width).toBeLessThanOrEqual(1920);
    expect(e.y + e.height).toBeLessThanOrEqual(1040);
    expect(e.y).toBe(1040 - expanded.height);
  });

  it('clamps near the left edge too', () => {
    expect(expandedFromMini({ x: 0, y: 0 }, primary.workArea)).toMatchObject({ x: 0, y: 0 });
  });
});
