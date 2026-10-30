/** Googly-eye maths (pure). */

export interface Vec {
  x: number;
  y: number;
}

/**
 * Pupil offset (in the eye's own units) for an eye centred at `eye` looking at `target`.
 * Points straight at the target, sliding further out the further away it is,
 * capped at `maxRadius` so the pupil stays inside the eye white.
 * `reach` is the distance at which the pupil hits the rim.
 */
export function pupilOffset(eye: Vec, target: Vec, maxRadius: number, reach = 120): Vec {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6 || maxRadius <= 0) return { x: 0, y: 0 };
  const r = maxRadius * Math.min(1, dist / reach);
  return { x: (dx / dist) * r, y: (dy / dist) * r };
}
