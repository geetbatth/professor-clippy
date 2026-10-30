import { describe, expect, it } from 'vitest';
import { ALPHA_THRESHOLD, buildMask, maskHit } from '../../src/renderer/src/clippy/alphaMask';

/** RGBA pixels, transparent except for the opaque pixels listed as [x, y]. */
function image(width: number, height: number, opaque: [number, number][]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(width * height * 4);
  for (const [x, y] of opaque) px[(y * width + x) * 4 + 3] = 255;
  return px;
}

describe('buildMask', () => {
  it('marks the cell holding an opaque pixel, grown by one cell each way', () => {
    // 12 × 12 px in 4 px cells: a 3 × 3 grid with one opaque pixel in the middle cell.
    const mask = buildMask(image(12, 12, [[5, 6]]), 12, 12, 4);
    expect(mask.cols).toBe(3);
    expect(mask.rows).toBe(3);
    expect([...mask.cells]).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
  });

  it('leaves far-away cells transparent', () => {
    const mask = buildMask(image(20, 4, [[0, 0]]), 20, 4, 4);
    expect([...mask.cells]).toEqual([1, 1, 0, 0, 0]);
  });

  it('ignores nearly transparent pixels (soft edges, shadows)', () => {
    const px = image(4, 4, []);
    px[3] = ALPHA_THRESHOLD;
    expect([...buildMask(px, 4, 4, 4).cells]).toEqual([0]);
    px[3] = ALPHA_THRESHOLD + 1;
    expect([...buildMask(px, 4, 4, 4).cells]).toEqual([1]);
  });

  it('copes with sizes that are not a multiple of the cell', () => {
    const mask = buildMask(image(10, 5, [[9, 4]]), 10, 5, 4);
    expect(mask.cols).toBe(3);
    expect(mask.rows).toBe(2);
    expect(maskHit(mask, 0.95, 0.95)).toBe(true);
  });
});

describe('maskHit', () => {
  const mask = buildMask(image(40, 40, [[2, 2]]), 40, 40, 4);
  it('hits the opaque corner and misses the empty far side', () => {
    expect(maskHit(mask, 0.05, 0.05)).toBe(true);
    expect(maskHit(mask, 0.9, 0.9)).toBe(false);
  });
  it('misses outside the image', () => {
    expect(maskHit(mask, -0.01, 0.05)).toBe(false);
    expect(maskHit(mask, 0.05, 1)).toBe(false);
    expect(maskHit(mask, Number.NaN, 0.5)).toBe(false);
  });
});
