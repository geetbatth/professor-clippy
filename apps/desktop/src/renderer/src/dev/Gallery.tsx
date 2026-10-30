import { useState, type CSSProperties } from 'react';
import { WINDOW_SIZES } from '../../../main/window/windowApi';
import { Clippy } from '../clippy/Clippy';
import { MOODS, type Mood } from '../clippy/mood';
import { STAGE, type Pose } from '../clippy/poses';
import './Gallery.css';

interface Cell {
  mood: Mood;
  big: boolean;
  mini: boolean;
  label: string;
}

const CELLS: Cell[] = [
  ...MOODS.map((mood) => ({ mood, big: false, mini: false, label: mood })),
  { mood: 'jump', big: true, mini: false, label: 'jump (big)' },
  { mood: 'idle', big: false, mini: true, label: 'mini' },
  { mood: 'sleep', big: false, mini: true, label: 'mini sleep' },
];

/** One mood per pose, for the onion-skin view. */
const POSE_CELLS: Record<Pose, Omit<Cell, 'label'>> = {
  idle: { mood: 'idle', big: false, mini: false },
  blink: { mood: 'blink', big: false, mini: false },
  thinking: { mood: 'think', big: false, mini: false },
  asleep: { mood: 'sleep', big: false, mini: false },
  'new-note': { mood: 'jump', big: false, mini: false },
  urgent: { mood: 'jump', big: true, mini: false },
  celebrate: { mood: 'celebrate', big: false, mini: false },
  knock: { mood: 'tapGlass', big: false, mini: false },
  mini: { mood: 'idle', big: false, mini: true },
};

/**
 * Dev-only character sheet (`?gallery=1`): every mood side by side, leaning after the cursor.
 * Click a cell to replay it. `&zoom=3` enlarges, `&only=idle,sleep` filters.
 * `&align=idle,knock` overlays those poses (onion skin, motion frozen) on one stage with the
 * anchor line and floor drawn in, for tuning POSE_TWEAKS in clippy/poses.ts.
 */
export function Gallery() {
  const [look, setLook] = useState<{ x: number; y: number } | null>(null);
  const [replays, setReplays] = useState<Record<string, number>>({});
  const params = new URLSearchParams(location.search);
  const zoom = Number(params.get('zoom')) || 1;
  const style = { '--zoom': zoom, '--stage-w': `${WINDOW_SIZES.mini.width}px`, '--stage-h': `${WINDOW_SIZES.mini.height}px` } as CSSProperties;

  const align = params.get('align');
  if (align !== null) {
    const all = Object.keys(POSE_CELLS) as Pose[];
    const pick = (list: string[]) => list.filter((p): p is Pose => p in POSE_CELLS);
    // `align=pairs`: idle against every other pose, one stage each.
    const stages = align === 'pairs' ? all.filter((p) => p !== 'idle').map((p): Pose[] => ['idle', p]) : [pick(align ? align.split(',') : all)];
    return (
      <div className="gallery gallery--align" style={style}>
        {stages.map((poses) => (
          <figure key={poses.join()} className="gallery-cell">
            <div className="gallery-stage">
              {poses.map((p) => (
                <div key={p} className="gallery-layer" style={{ opacity: Math.max(0.25, 1 / poses.length + 0.15) }}>
                  <Clippy {...POSE_CELLS[p]} />
                </div>
              ))}
              <div className="gallery-guide" style={{ left: `${(STAGE.anchorX / STAGE.width) * 100}%` }} />
            </div>
            <figcaption>{poses.join(' + ')}</figcaption>
          </figure>
        ))}
      </div>
    );
  }

  const only = params.get('only')?.split(',');
  const cells = only ? CELLS.filter((c) => only.includes(c.label)) : CELLS;
  return (
    <div className="gallery" style={style} onMouseMove={(e) => setLook({ x: e.clientX, y: e.clientY })}>
      {cells.map((c) => (
        <figure
          key={c.label}
          className="gallery-cell"
          onClick={() => setReplays((r) => ({ ...r, [c.label]: (r[c.label] ?? 0) + 1 }))}
        >
          <div className="gallery-stage">
            <Clippy mood={c.mood} big={c.big} mini={c.mini} seq={replays[c.label] ?? 0} look={look} />
          </div>
          <figcaption>{c.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}
