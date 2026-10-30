import { useLayoutEffect, useState, type PointerEventHandler } from 'react';
import type { Mood } from './mood';
import { pupilOffset, type Vec } from './pupils';
import { EYES, PUPIL_R, VIEWBOX_ATTR } from './rig';
import { Arms, KnockFist } from './parts/Arms';
import { BowTie } from './parts/BowTie';
import { Confetti, Effects } from './parts/Effects';
import { Eyebrows } from './parts/Eyebrows';
import { Eyes } from './parts/Eyes';
import { Glasses } from './parts/Glasses';
import { Hat } from './parts/Hat';
import { Mouth } from './parts/Mouth';
import { ClippyDefs, Wire } from './parts/Wire';
import './Clippy.css';

export interface ClippyProps {
  mood: Mood;
  /** Bigger antics (urgent / long-ignored). */
  big?: boolean;
  /** Bumps on every new transient; remounting replays its CSS animations. */
  seq?: number;
  /** Cursor in client (window) coordinates, for the googly eyes. */
  look?: Vec | null;
  /** Ground shadow (mini mode, standing on the desktop). */
  shadow?: boolean;
  /** Pointer handlers for Clippy's body (drag / click). */
  onPointerDown?: PointerEventHandler<SVGRectElement>;
  onPointerMove?: PointerEventHandler<SVGRectElement>;
  onPointerUp?: PointerEventHandler<SVGRectElement>;
  title?: string;
}

const STILL: readonly Vec[] = [
  { x: 0, y: 0 },
  { x: 0, y: 0 },
];

/** Map the client-space cursor to per-eye pupil offsets in SVG units. */
function useGaze(svg: SVGSVGElement | null, look: Vec | null | undefined): readonly Vec[] {
  const [gaze, setGaze] = useState<readonly Vec[]>(STILL);
  useLayoutEffect(() => {
    const ctm = svg?.getScreenCTM();
    if (!svg || !ctm || !look) {
      setGaze(STILL);
      return;
    }
    const inv = ctm.inverse();
    // Cursor in SVG user units.
    const target = new DOMPoint(look.x, look.y).matrixTransform(inv);
    setGaze(EYES.map((e) => pupilOffset({ x: e.cx, y: e.cy }, target, e.r - PUPIL_R - 0.8, 90)));
  }, [svg, look]);
  return gaze;
}

/** Professor Clippy: an original paperclip professor, drawn and animated in SVG + CSS. */
export function Clippy({ mood, big = false, seq = 0, look, shadow = false, title, ...pointer }: ClippyProps) {
  const [svg, setSvg] = useState<SVGSVGElement | null>(null);
  const gaze = useGaze(svg, look);
  const avg = { x: ((gaze[0]?.x ?? 0) + (gaze[1]?.x ?? 0)) / 2, y: ((gaze[0]?.y ?? 0) + (gaze[1]?.y ?? 0)) / 2 };

  return (
    <svg
      ref={setSvg}
      className="clippy"
      viewBox={VIEWBOX_ATTR}
      preserveAspectRatio="xMidYMax meet"
      data-mood={mood}
      data-big={big ? 'true' : 'false'}
      role="img"
      aria-label={title ?? `Professor Clippy (${mood})`}
    >
      <ClippyDefs />
      {shadow && <ellipse className="clippy-shadow" cx="71" cy="156.5" rx="25" ry="3.6" />}
      <g className="clippy-stage" key={seq}>
        <g className="clippy-body">
          <Wire />
          <BowTie />
          <Mouth />
          <Arms />
          {/* The face turns slightly towards whatever the eyes are looking at. */}
          <g
            className="clippy-face"
            style={{ transform: `translate(${(avg.x * 0.35).toFixed(2)}px, ${(avg.y * 0.25).toFixed(2)}px)` }}
          >
            <Eyes gaze={gaze} />
            <Glasses />
          </g>
          <Hat />
          <Eyebrows />
          <KnockFist />
        </g>
        <Effects />
      </g>
      <g key={`fx-${seq}`}>
        <Confetti />
      </g>
      <rect
        className="clippy-hit"
        data-solid=""
        x="34"
        y="8"
        width="76"
        height="150"
        rx="22"
        {...pointer}
      />
    </svg>
  );
}
