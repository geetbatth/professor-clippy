import { SHOULDER_L, SHOULDER_R } from '../rig';
import './Arms.css';

/** A white cartoon glove: palm, thumb and a cuff. */
function Glove({ x, y, flip }: { x: number; y: number; flip: boolean }) {
  const s = flip ? -1 : 1;
  return (
    <g className="glove">
      <circle className="glove-palm" cx={x} cy={y} r="5.3" />
      <ellipse className="glove-thumb" cx={x + 4.2 * s} cy={y - 2.6} rx="2.3" ry="2.9" />
      <path className="glove-line" d={`M ${x - 2.4 * s} ${y + 1.4} q ${1.6 * s} 1.4 ${3.4 * s} 0.6`} />
    </g>
  );
}

/** Wiry arms hinged at the shoulders, so moods can swing them about. */
export function Arms() {
  const l = SHOULDER_L;
  const r = SHOULDER_R;
  return (
    <g className="clippy-arms">
      <g className="arm arm-l">
        <path className="arm-wire" d={`M ${l.x} ${l.y} C ${l.x - 6} ${l.y + 4} ${l.x - 10} ${l.y + 10} ${l.x - 12} ${l.y + 18}`} />
        <g className="glove-wrap glove-l">
          <Glove x={l.x - 13} y={l.y + 22} flip={false} />
        </g>
      </g>
      <g className="arm arm-r">
        <path className="arm-wire" d={`M ${r.x} ${r.y} C ${r.x + 6} ${r.y + 4} ${r.x + 10} ${r.y + 10} ${r.x + 12} ${r.y + 18}`} />
        <g className="glove-wrap glove-r">
          <Glove x={r.x + 13} y={r.y + 22} flip />
        </g>
      </g>
    </g>
  );
}

/**
 * tapGlass: a big gloved fist that knocks on the inside of your screen.
 * Drawn above the face (it's nearer to you than he is); shown only while knocking.
 */
export function KnockFist() {
  return (
    <g className="clippy-fist">
      <g className="fist">
        <circle className="glove-palm" cx="106" cy="85" r="6.4" />
        <path className="fist-knuckles" d="M 100.8 83.4 q 1.4 -1.8 2.9 0 M 103.9 82.2 q 1.5 -1.8 3 0 M 107.1 82.4 q 1.5 -1.8 3 0" />
        <path className="glove-line" d="M 102 88.5 q 4 2 8 -0.5" />
      </g>
      <path className="fist-impact" d="M 116 75 l 4.5 -4 M 119 85 l 6 0 M 116 95 l 4.5 4 M 106 72.5 l 0 -5.5" />
    </g>
  );
}
