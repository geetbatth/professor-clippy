import { describe, expect, it } from 'vitest';
import { pupilOffset } from '../../src/renderer/src/clippy/pupils';

describe('pupilOffset', () => {
  it('looks straight at a far target, capped at the rim', () => {
    const o = pupilOffset({ x: 0, y: 0 }, { x: 1000, y: 0 }, 5);
    expect(o.x).toBeCloseTo(5);
    expect(o.y).toBeCloseTo(0);
  });

  it('moves less for close targets', () => {
    const o = pupilOffset({ x: 10, y: 10 }, { x: 10, y: 70 }, 6, 120);
    expect(o).toEqual({ x: 0, y: 3 });
  });

  it('never leaves the eye, in any direction', () => {
    for (let a = 0; a < Math.PI * 2; a += 0.3) {
      const o = pupilOffset({ x: 0, y: 0 }, { x: Math.cos(a) * 500, y: Math.sin(a) * 500 }, 4);
      expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(4 + 1e-9);
    }
  });

  it('centres when the target is on the eye', () => {
    expect(pupilOffset({ x: 3, y: 3 }, { x: 3, y: 3 }, 5)).toEqual({ x: 0, y: 0 });
  });
});
