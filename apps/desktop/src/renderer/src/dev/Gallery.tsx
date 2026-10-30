import { useState, type CSSProperties } from 'react';
import { Clippy } from '../clippy/Clippy';
import { MOODS, type Mood } from '../clippy/mood';
import './Gallery.css';

const CELLS: { mood: Mood; big: boolean; label: string }[] = [
  ...MOODS.map((mood) => ({ mood, big: false, label: mood })),
  { mood: 'jump', big: true, label: 'jump (big)' },
];

/**
 * Dev-only character sheet (`?gallery=1`): every mood side by side, eyes following the cursor.
 * Click a cell to replay it. `&zoom=3` enlarges, `&only=idle,sleep` filters.
 */
export function Gallery() {
  const [look, setLook] = useState<{ x: number; y: number } | null>(null);
  const [replays, setReplays] = useState<Record<string, number>>({});
  const zoom = Number(new URLSearchParams(location.search).get('zoom')) || 1;
  const only = new URLSearchParams(location.search).get('only')?.split(',');
  const cells = only ? CELLS.filter((c) => only.includes(c.label)) : CELLS;
  return (
    <div className="gallery" style={{ '--zoom': zoom } as CSSProperties} onMouseMove={(e) => setLook({ x: e.clientX, y: e.clientY })}>
      {cells.map((c) => (
        <figure
          key={c.label}
          className="gallery-cell"
          onClick={() => setReplays((r) => ({ ...r, [c.label]: (r[c.label] ?? 0) + 1 }))}
        >
          <div className="gallery-stage">
            <Clippy mood={c.mood} big={c.big} seq={replays[c.label] ?? 0} look={look} shadow />
          </div>
          <figcaption>{c.label}</figcaption>
        </figure>
      ))}
    </div>
  );
}
