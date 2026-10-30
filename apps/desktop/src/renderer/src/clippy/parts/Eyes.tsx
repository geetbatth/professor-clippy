import type { Vec } from '../pupils';
import { EYES, PUPIL_R } from '../rig';
import './Eyes.css';

/**
 * Googly eyes. `gaze[i]` is each pupil's offset (user units) towards the cursor;
 * moods can override it in CSS (reading looks down, thinking looks up...).
 * Lids drop for blinks and sleep; the "closed" line shows while asleep.
 */
export function Eyes({ gaze }: { gaze: readonly Vec[] }) {
  return (
    <g className="clippy-eyes">
      {EYES.map((e, i) => {
        const g = gaze[i] ?? { x: 0, y: 0 };
        const clipId = `clippy-eye-clip-${i}`;
        return (
          <g key={i} className={`eye eye-${i}`} style={{ transformOrigin: `${e.cx}px ${e.cy}px` }}>
            <clipPath id={clipId}>
              <circle cx={e.cx} cy={e.cy} r={e.r} />
            </clipPath>
            <circle className="eye-white" cx={e.cx} cy={e.cy} r={e.r} />
            <g clipPath={`url(#${clipId})`}>
              <g className="pupil-track" style={{ transform: `translate(${g.x.toFixed(2)}px, ${g.y.toFixed(2)}px)` }}>
                <g className="pupil-pose" style={{ transformOrigin: `${e.cx}px ${e.cy}px` }}>
                  <circle className="pupil" cx={e.cx} cy={e.cy} r={PUPIL_R} />
                  <circle className="pupil-glint" cx={e.cx - 1.5} cy={e.cy - 1.7} r={1.35} />
                  <circle className="pupil-glint small" cx={e.cx + 1.6} cy={e.cy + 1.5} r={0.6} />
                </g>
              </g>
              <g className="eye-lid" style={{ transformOrigin: `${e.cx}px ${e.cy - e.r}px` }}>
                <rect x={e.cx - e.r - 1} y={e.cy - e.r - 1} width={e.r * 2 + 2} height={e.r * 2 + 2} />
              </g>
              <path
                className="eye-closed"
                d={
                  `M ${e.cx - e.r * 0.7} ${e.cy + 1} Q ${e.cx} ${e.cy + e.r * 0.55} ${e.cx + e.r * 0.7} ${e.cy + 1}` +
                  // three sleepy lashes
                  ` M ${e.cx - e.r * 0.4} ${e.cy + 2.7} l -1.3 2.6 M ${e.cx} ${e.cy + 3.4} l 0 2.9 M ${e.cx + e.r * 0.4} ${e.cy + 2.7} l 1.3 2.6`
                }
              />
            </g>
            <circle className="eye-rim" cx={e.cx} cy={e.cy} r={e.r} />
          </g>
        );
      })}
    </g>
  );
}
