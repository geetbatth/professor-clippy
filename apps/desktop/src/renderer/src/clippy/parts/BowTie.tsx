import './BowTie.css';

const DOTS: readonly [number, number][] = [
  [59, 94],
  [62.5, 100],
  [58.5, 99.5],
  [83, 94],
  [79.5, 100],
  [83.5, 99.5],
];

/** A red polka-dot bow tie. It spins when he's very pleased. */
export function BowTie() {
  return (
    <g className="clippy-bowtie">
      <path className="bowtie-wing" d="M 68.5 97 L 55.5 89.5 Q 52.5 97 55.5 104.5 Z" />
      <path className="bowtie-wing" d="M 73.5 97 L 86.5 89.5 Q 89.5 97 86.5 104.5 Z" />
      {DOTS.map(([cx, cy], i) => (
        <circle key={i} className="bowtie-dot" cx={cx} cy={cy} r="1.1" />
      ))}
      <rect className="bowtie-knot" x="67.5" y="93.5" width="7" height="7.5" rx="2.2" />
    </g>
  );
}
