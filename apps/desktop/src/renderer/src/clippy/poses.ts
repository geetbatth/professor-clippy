/**
 * Professor Clippy's sprite poses (pure: no DOM, no asset imports, so it is unit-testable).
 *
 * The robot is a set of painted sprites (`sprites/*.webp`), all cut from one sheet at the same
 * pixel scale. `sprites.json` gives each one's size and `bodyCenterX` (the canister's horizontal
 * centre as a fraction of the width). Every pose is laid out on one stage, bottom-anchored with
 * its body centre on the stage's anchor line, then nudged by a small per-pose tweak table so the
 * body doesn't jump when the pose changes. Motion (bob, hop, roll-in, shake...) is CSS.
 */
import meta from './sprites/sprites.json';
import type { Mood } from './mood';

export const POSES = ['idle', 'blink', 'thinking', 'asleep', 'new-note', 'urgent', 'celebrate', 'knock', 'mini'] as const;
export type Pose = (typeof POSES)[number];

export interface SpriteMeta {
  /** Natural size in sprite pixels. */
  w: number;
  h: number;
  /** The body's horizontal centre, as a fraction of `w`. */
  bodyCenterX: number;
}

export const SPRITES: Readonly<Record<Pose, SpriteMeta>> = meta;

/**
 * The stage every pose stands on, in sprite pixels. Its aspect ratio matches the mini window
 * (`WINDOW_SIZES.mini`), which is exactly one stage. `anchorX` is where the body centre goes;
 * the bottom edge is the floor (the wheels).
 */
export const STAGE = { width: 600, height: 740, anchorX: 315 } as const;

export interface PoseTweak {
  /** Nudge right (sprite px). */
  dx: number;
  /** Lift off the floor (sprite px). */
  dy: number;
  /** Size multiplier. */
  scale: number;
}

/**
 * Per-pose alignment, so the canister (the "PROF. CLIPPY" stencil) stays put between poses.
 * Measured by matching each sprite's stencil against idle's, then checked by eye in the gallery's
 * onion-skin view (`?gallery=1&align=idle,knock`).
 * - `dx` also corrects `bodyCenterX` where the painting's canister isn't where sprites.json says
 *   (idle/blink, new-note and knock are 25–60 px off), putting every canister on the anchor line.
 * - `scale` evens out the paintings' sizes (celebrate is painted ~18% smaller, asleep ~9%).
 * - Wheels stay on the floor (`dy` 0) for the standing poses; the airborne ones (urgent, celebrate)
 *   float a little so the canister doesn't sink.
 * - `knock` is a close-up (no wheels, faded bottom) painted ~1.34× bigger; it is shown at ~1.12× so
 *   it reads as leaning in towards the glass, lifted so his face stays near idle's.
 * - `mini` (sunk into the canister) is matched in scale; his wheels stay on the floor.
 */
export const POSE_TWEAKS: Readonly<Record<Pose, PoseTweak>> = {
  idle: { dx: -29, dy: 0, scale: 1 },
  blink: { dx: -29, dy: 0, scale: 1 },
  thinking: { dx: 1, dy: 0, scale: 1 },
  asleep: { dx: 12, dy: 0, scale: 1.09 },
  'new-note': { dx: -58, dy: 0, scale: 1.04 },
  urgent: { dx: -4, dy: 15, scale: 1.06 },
  celebrate: { dx: -3, dy: 30, scale: 1.14 },
  knock: { dx: -23, dy: 110, scale: 0.84 },
  mini: { dx: -2, dy: 0, scale: 1.11 },
};

/** A box on the stage, as fractions of the stage's width and height (CSS percentages). */
export interface StageRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Where `pose`'s sprite sits on the stage. */
export function poseRect(pose: Pose): StageRect {
  const s = SPRITES[pose];
  const t = POSE_TWEAKS[pose];
  const w = s.w * t.scale;
  const h = s.h * t.scale;
  const left = STAGE.anchorX + t.dx - s.bodyCenterX * w;
  const top = STAGE.height - t.dy - h;
  return { left: left / STAGE.width, top: top / STAGE.height, width: w / STAGE.width, height: h / STAGE.height };
}

/** A point given as fractions of `pose`'s sprite, as fractions of the stage. */
export function spotOn(pose: Pose, fx: number, fy: number): { x: number; y: number } {
  const r = poseRect(pose);
  return { x: r.left + fx * r.width, y: r.top + fy * r.height };
}

/** The blueprint in `new-note` (centre and radii as fractions of the sprite), for the glow behind it. */
export const BLUEPRINT_GLOW = { pose: 'new-note', cx: 0.28, cy: 0.66, rx: 0.3, ry: 0.2 } as const satisfies {
  pose: Pose;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
};

/** Moods in which mini Clippy stays sunk in his canister; the big antics pop him out. */
const MINI_MOODS: ReadonlySet<Mood> = new Set<Mood>(['idle', 'blink', 'read', 'sleep', 'think', 'wake']);

/**
 * Which sprite a mood shows. In mini mode he rests sunk into his canister (`mini`), and pops out
 * for the antics that need attention (new note, urgent, knock, celebrate).
 */
export function spriteFor(mood: Mood, big: boolean, mini: boolean): Pose {
  if (mini && MINI_MOODS.has(mood)) return 'mini';
  switch (mood) {
    case 'idle':
    case 'read':
    case 'wake':
      return 'idle';
    case 'blink':
      return 'blink';
    case 'sleep':
      return 'asleep';
    case 'jump':
      return big ? 'urgent' : 'new-note';
    case 'tapGlass':
      return 'knock';
    case 'think':
      return 'thinking';
    case 'celebrate':
      return 'celebrate';
  }
}

/** The CSS motion a mood plays (`data-motion`); see Clippy.css. */
export type Motion = 'bob' | 'hop' | 'roll-in' | 'urgent' | 'knock' | 'ponder' | 'snooze' | 'celebrate';

export function motionFor(mood: Mood, big: boolean): Motion {
  switch (mood) {
    case 'idle':
    case 'blink':
    case 'read':
      // Same motion for all three, so a blink or opening the note never restarts the bob.
      return 'bob';
    case 'wake':
      return 'hop';
    case 'jump':
      return big ? 'urgent' : 'roll-in';
    case 'tapGlass':
      return 'knock';
    case 'think':
      return 'ponder';
    case 'sleep':
      return 'snooze';
    case 'celebrate':
      return 'celebrate';
  }
}

/** Furthest he leans towards the cursor, in degrees. */
export const MAX_LEAN_DEG = 3;
/** Cursor distance (px, horizontally) at which the lean is full. */
export const LEAN_REACH_PX = 260;
/** Reading the note (below and to his left): a slight lean towards it. */
export const READ_LEAN_DEG = -3;

/**
 * How far he leans (degrees, + = clockwise, towards the right): towards the cursor while
 * resting, plus a tilt towards the note while reading. `dx` is the cursor's horizontal distance
 * from his body centre (px), or undefined when there is no cursor.
 */
export function leanFor(mood: Mood, dx: number | undefined): number {
  if (mood !== 'idle' && mood !== 'blink' && mood !== 'read') return 0;
  const cursor = dx === undefined ? 0 : Math.max(-1, Math.min(1, dx / LEAN_REACH_PX)) * MAX_LEAN_DEG;
  const lean = (mood === 'read' ? READ_LEAN_DEG : 0) + cursor;
  return Math.round(lean * 100) / 100;
}
