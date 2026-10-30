import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEventHandler } from 'react';
import type { CursorPoint } from '../../../main/window/windowApi';
import { requestHitRecheck, setHitTest } from '../hooks/useClickThrough';
import { maskHit } from './alphaMask';
import type { Mood } from './mood';
import { BLUEPRINT_GLOW, leanFor, leansToCursor, motionFor, poseRect, POSES, spotOn, spriteFor, STAGE, type Pose } from './poses';
import { SPRITE_URLS, spriteMask } from './sprites';
import './Clippy.css';

export interface ClippyProps {
  mood: Mood;
  /** Bigger antics (urgent / long-ignored). */
  big?: boolean;
  /** Replay key (bumps on each non-blink transient): restarts the one-shot motion. */
  seq?: number;
  /** Cursor in client (window) coordinates: he leans a little towards it. */
  look?: CursorPoint | null;
  /** Mini mode: he rests sunk into his canister, standing on the desktop with a ground shadow. */
  mini?: boolean;
  /** Pointer handlers for Clippy's body (drag / click). */
  onPointerDown?: PointerEventHandler<HTMLDivElement>;
  onPointerMove?: PointerEventHandler<HTMLDivElement>;
  onPointerUp?: PointerEventHandler<HTMLDivElement>;
  onPointerCancel?: PointerEventHandler<HTMLDivElement>;
  onLostPointerCapture?: PointerEventHandler<HTMLDivElement>;
  title?: string;
}

const pct = (f: number) => `${(f * 100).toFixed(3)}%`;
const ANCHOR_X = STAGE.anchorX / STAGE.width;

/** Each pose's box on the stage (fixed, so computed once). */
const POSE_STYLES = Object.fromEntries(
  POSES.map((p) => {
    const r = poseRect(p);
    return [p, { left: pct(r.left), top: pct(r.top), width: pct(r.width), height: pct(r.height) }];
  }),
) as Record<Pose, CSSProperties>;

const GLOW_STYLE: CSSProperties = (() => {
  const g = BLUEPRINT_GLOW;
  const r = poseRect(g.pose);
  const c = spotOn(g.pose, g.cx, g.cy);
  return {
    left: pct(c.x - g.rx * r.width),
    top: pct(c.y - g.ry * r.height),
    width: pct(2 * g.rx * r.width),
    height: pct(2 * g.ry * r.height),
  };
})();

const ZZZ_SPOT = spotOn('mini', 0.86, 0.06);
const ZZZ_STYLE: CSSProperties = { left: pct(ZZZ_SPOT.x), top: pct(ZZZ_SPOT.y) };

/**
 * Horizontal distance (px) from his body centre to the cursor, measured after layout. With no
 * cursor (he isn't leaning, or motion is reduced) it reads no layout and doesn't re-render.
 */
function useCursorDx(root: HTMLDivElement | null, look: CursorPoint | null | undefined): number | undefined {
  const [dx, setDx] = useState<number>();
  useLayoutEffect(() => {
    if (!root || !look) {
      setDx(undefined);
      return;
    }
    const box = root.getBoundingClientRect();
    setDx(Math.round(look.x - (box.left + box.width * ANCHOR_X)));
  }, [root, look]);
  return dx;
}

/**
 * A client point as fractions of `pose`'s sprite box, undoing the stage's transforms (the lean
 * and the motion: rotations, hops, scales), not just their axis-aligned bounding box.
 */
function spriteFraction(img: HTMLImageElement, pose: Pose, x: number, y: number): { fx: number; fy: number } | undefined {
  const root = img.closest('.clippy');
  if (!root) return undefined;
  const chain: Element[] = [];
  for (let el = img.parentElement; el && el !== root; el = el.parentElement) chain.unshift(el);
  // Each layer fills the stage, so their transforms compose in the stage's own coordinates.
  let m = new DOMMatrix();
  for (const el of chain) {
    const cs = getComputedStyle(el);
    if (cs.transform === 'none') continue;
    const [ox = 0, oy = 0] = cs.transformOrigin.split(' ').map(parseFloat);
    m = m.translate(ox, oy).multiply(new DOMMatrix(cs.transform)).translate(-ox, -oy);
  }
  const box = root.getBoundingClientRect();
  const p = m.inverse().transformPoint(new DOMPoint(x - box.left, y - box.top));
  const r = poseRect(pose);
  return { fx: (p.x / box.width - r.left) / r.width, fy: (p.y / box.height - r.top) / r.height };
}

/** One sprite of the stack; only the current pose is visible. Clicks pass through its transparent pixels. */
function Sprite({ pose, active }: { pose: Pose; active: boolean }) {
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const img = ref.current;
    if (!img) return;
    setHitTest(img, (x, y) => {
      if (img.dataset.active !== 'true') return false;
      const mask = spriteMask(pose);
      if (!mask) return true;
      const f = spriteFraction(img, pose, x, y);
      return f !== undefined && maskHit(mask, f.fx, f.fy);
    });
    return () => setHitTest(img, undefined);
  }, [pose]);
  return (
    <img
      ref={ref}
      className="clippy-sprite"
      src={SPRITE_URLS[pose]}
      alt=""
      draggable={false}
      data-solid=""
      data-active={active ? 'true' : 'false'}
      style={POSE_STYLES[pose]}
    />
  );
}

/**
 * Professor Clippy: a riveted canister robot with a paperclip head, painted as sprites and moved
 * with CSS. Every pose is stacked (and preloaded), so swapping poses is just a visibility change.
 */
export function Clippy({ mood, big = false, seq = 0, look, mini = false, title, ...pointer }: ClippyProps) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const motionRef = useRef<HTMLDivElement>(null);
  const pose = spriteFor(mood, big, mini);
  const motion = motionFor(mood, big);
  const lean = leanFor(mood, useCursorDx(root, leansToCursor(mood) ? look : null));

  // A new pose (or mode) changes what's solid under a cursor that hasn't moved.
  useLayoutEffect(() => requestHitRecheck(), [pose, mini]);

  // Replay the one-shot motion when a new transient starts, even if it's the same as the last.
  const firstSeq = useRef(seq);
  useLayoutEffect(() => {
    const el = motionRef.current;
    if (!el || seq === firstSeq.current) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    el.style.animation = '';
  }, [seq]);

  return (
    <div
      ref={setRoot}
      className="clippy"
      data-mood={mood}
      data-pose={pose}
      data-motion={motion}
      data-big={big ? 'true' : 'false'}
      data-mini={mini ? 'true' : 'false'}
      role="img"
      aria-label={title ?? `Professor Clippy (${mood})`}
      title={title}
      style={{ aspectRatio: `${STAGE.width} / ${STAGE.height}`, '--anchor-x': pct(ANCHOR_X), '--lean': `${lean}deg` } as CSSProperties}
    >
      {mini && <div className="clippy-shadow" />}
      <div className="clippy-lean">
        <div className="clippy-motion" ref={motionRef}>
          {pose === BLUEPRINT_GLOW.pose && <div className="clippy-glow" style={GLOW_STYLE} />}
          <div className="clippy-body" {...pointer}>
            {POSES.map((p) => (
              <Sprite key={p} pose={p} active={p === pose} />
            ))}
          </div>
          {pose === 'mini' && mood === 'sleep' && (
            <div className="clippy-zzz" style={ZZZ_STYLE} aria-hidden="true">
              <span>z</span>
              <span>z</span>
              <span>z</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
