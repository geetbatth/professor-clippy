import { describe, expect, it } from 'vitest';
import { WINDOW_SIZES } from '../../src/main/window/windowApi';
import { MOODS, type Mood } from '../../src/renderer/src/clippy/mood';
import {
  leanFor,
  MAX_LEAN_DEG,
  motionFor,
  POSE_TWEAKS,
  poseRect,
  POSES,
  READ_LEAN_DEG,
  SPRITES,
  spriteFor,
  STAGE,
  type Pose,
} from '../../src/renderer/src/clippy/poses';
import meta from '../../src/renderer/src/clippy/sprites/sprites.json';

describe('sprites', () => {
  it('every pose has its sprite metadata, and nothing else is listed', () => {
    expect(Object.keys(meta).sort()).toEqual([...POSES].sort());
    for (const p of POSES) {
      expect(SPRITES[p].w).toBeGreaterThan(0);
      expect(SPRITES[p].h).toBeGreaterThan(0);
      expect(SPRITES[p].bodyCenterX).toBeGreaterThan(0);
      expect(SPRITES[p].bodyCenterX).toBeLessThan(1);
    }
  });

  it('the mini window is exactly one stage (same aspect ratio)', () => {
    const { width, height } = WINDOW_SIZES.mini;
    expect(width / height).toBeCloseTo(STAGE.width / STAGE.height, 2);
  });
});

describe('spriteFor', () => {
  const cases: [Mood, boolean, Pose][] = [
    ['idle', false, 'idle'],
    ['blink', false, 'blink'],
    ['read', false, 'idle'],
    ['sleep', false, 'asleep'],
    ['wake', false, 'idle'],
    ['jump', false, 'new-note'],
    ['jump', true, 'urgent'],
    ['tapGlass', false, 'knock'],
    ['think', false, 'thinking'],
    ['celebrate', false, 'celebrate'],
  ];
  it.each(cases)('%s (big: %s) shows %s', (mood, big, pose) => {
    expect(spriteFor(mood, big, false)).toBe(pose);
  });

  it('every mood has a sprite', () => {
    for (const mood of MOODS) for (const big of [false, true]) for (const mini of [false, true]) expect(POSES).toContain(spriteFor(mood, big, mini));
  });

  it('mini mode rests in the canister and pops out for the antics', () => {
    for (const mood of ['idle', 'blink', 'read', 'sleep', 'think', 'wake'] as const) expect(spriteFor(mood, false, true)).toBe('mini');
    expect(spriteFor('jump', false, true)).toBe('new-note');
    expect(spriteFor('jump', true, true)).toBe('urgent');
    expect(spriteFor('tapGlass', false, true)).toBe('knock');
    expect(spriteFor('celebrate', false, true)).toBe('celebrate');
  });

  it('mini is only ever shown in mini mode', () => {
    for (const mood of MOODS) for (const big of [false, true]) expect(spriteFor(mood, big, false)).not.toBe('mini');
  });
});

describe('motionFor', () => {
  it('idle, blink and read share the bob, so a blink never restarts it', () => {
    expect(motionFor('idle', false)).toBe('bob');
    expect(motionFor('blink', false)).toBe('bob');
    expect(motionFor('read', false)).toBe('bob');
  });
  it('the transients get their own motion', () => {
    expect(motionFor('wake', false)).toBe('hop');
    expect(motionFor('jump', false)).toBe('roll-in');
    expect(motionFor('jump', true)).toBe('urgent');
    expect(motionFor('tapGlass', false)).toBe('knock');
    expect(motionFor('celebrate', false)).toBe('celebrate');
    expect(motionFor('think', false)).toBe('ponder');
    expect(motionFor('sleep', false)).toBe('snooze');
  });
});

describe('leanFor', () => {
  it('leans towards the cursor while resting, capped', () => {
    expect(leanFor('idle', 0)).toBe(0);
    expect(leanFor('idle', 10_000)).toBe(MAX_LEAN_DEG);
    expect(leanFor('idle', -10_000)).toBe(-MAX_LEAN_DEG);
    expect(leanFor('idle', 50)).toBeGreaterThan(0);
    expect(leanFor('idle', 50)).toBeLessThan(MAX_LEAN_DEG);
    expect(leanFor('idle', undefined)).toBe(0);
  });
  it('tilts towards the note while reading', () => {
    expect(leanFor('read', undefined)).toBe(READ_LEAN_DEG);
    expect(leanFor('read', 10_000)).toBe(READ_LEAN_DEG + MAX_LEAN_DEG);
  });
  it('keeps still during antics and sleep', () => {
    for (const mood of ['sleep', 'wake', 'jump', 'tapGlass', 'think', 'celebrate'] as const) expect(leanFor(mood, 200)).toBe(0);
  });
});

/**
 * The alignment table, checked against where the "PROF. CLIPPY" stencil really is in each
 * painting: its centre and its size relative to idle's (sprite px), measured once by matching
 * idle's stencil against each sprite (normalised cross-correlation).
 */
const STENCIL: Record<Pose, { x: number; y: number; size: number }> = {
  idle: { x: 338.5, y: 327, size: 1 },
  blink: { x: 337.5, y: 327, size: 1 },
  thinking: { x: 231, y: 336.9, size: 1.02 },
  asleep: { x: 153.4, y: 314.4, size: 0.92 },
  'new-note': { x: 380.8, y: 335.7, size: 0.86 },
  urgent: { x: 269.4, y: 328.2, size: 0.96 },
  celebrate: { x: 247.7, y: 316.9, size: 0.82 },
  knock: { x: 287.5, y: 458.3, size: 1.34 },
  mini: { x: 141.9, y: 237.5, size: 0.9 },
};

/** Where `pose`'s stencil lands on the stage: x from the left, y above the floor, and its shown size. */
function stencilOnStage(pose: Pose) {
  const r = poseRect(pose);
  const s = SPRITES[pose];
  const st = STENCIL[pose];
  return {
    x: (r.left + (st.x / s.w) * r.width) * STAGE.width,
    above: (1 - (r.top + (st.y / s.h) * r.height)) * STAGE.height,
    size: st.size * POSE_TWEAKS[pose].scale,
  };
}

describe('pose alignment', () => {
  it('puts every canister on the anchor line', () => {
    for (const p of POSES) expect(Math.abs(stencilOnStage(p).x - STAGE.anchorX), p).toBeLessThan(6);
  });

  it('shows every canister at the same size, except the knock close-up which leans in', () => {
    for (const p of POSES) {
      const { size } = stencilOnStage(p);
      if (p === 'knock') {
        expect(size).toBeGreaterThan(1.05);
        expect(size).toBeLessThan(1.25);
      } else if (p === 'new-note') {
        // The canister is tilted in this painting, so the match is rougher.
        expect(size, p).toBeGreaterThan(0.85);
      } else {
        expect(Math.abs(size - 1), p).toBeLessThan(0.07);
      }
    }
  });

  it('keeps the canister at the same height in the full-body poses', () => {
    const idle = stencilOnStage('idle').above;
    for (const p of ['blink', 'thinking', 'asleep', 'urgent', 'celebrate'] as const) {
      expect(Math.abs(stencilOnStage(p).above - idle), p).toBeLessThan(20);
    }
    // Mini is sunk into the canister; the full poses pop him out of it.
    expect(stencilOnStage('mini').above).toBeLessThan(idle - 50);
  });

  it('stands the grounded poses on the floor', () => {
    for (const p of ['idle', 'blink', 'thinking', 'asleep', 'new-note', 'mini'] as const) {
      const r = poseRect(p);
      expect(r.top + r.height, p).toBeCloseTo(1, 6);
    }
  });

  it('fits every pose under the top and inside the right edge (the window edge in both modes)', () => {
    for (const p of POSES) {
      const r = poseRect(p);
      expect(r.top, p).toBeGreaterThanOrEqual(0);
      expect(r.left + r.width, p).toBeLessThanOrEqual(1);
    }
  });

  it('fits the poses mini mode can show inside the mini window', () => {
    // idle's and new-note's blueprints reach past the left edge, into the expanded window's free space;
    // in mini mode he rests as `mini`, and a new note opens the note first.
    for (const p of ['mini', 'knock', 'celebrate', 'urgent'] as const) {
      const r = poseRect(p);
      expect(r.left, p).toBeGreaterThanOrEqual(0);
      expect(r.top + r.height, p).toBeLessThanOrEqual(1);
    }
  });
});
