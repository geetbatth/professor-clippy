import './Hat.css';

/** Mortarboard, worn at a jaunty angle, with a gold tassel that swings. */
export function Hat() {
  return (
    <g className="clippy-hat">
      <g className="hat-tilt">
        <path className="hat-cap" d="M 53.5 25 L 53.5 35.5 Q 67 42.5 80.5 35.5 L 80.5 25 Z" />
        <path className="hat-cap-shade" d="M 53.5 31 Q 67 37 80.5 31 L 80.5 35.5 Q 67 42.5 53.5 35.5 Z" />
        <path className="hat-board-edge" d="M 38 24 L 67 35.5 L 96 24 L 96 27.5 L 67 39 L 38 27.5 Z" />
        <path className="hat-board" d="M 38 24 L 67 12.5 L 96 24 L 67 35.5 Z" />
        <path className="hat-board-shine" d="M 43 23.6 L 67 14.2" />
        <path className="hat-cord" d="M 67 24 Q 81 23 93.5 25.5" />
        <circle className="hat-button" cx="67" cy="24" r="2.3" />
        <g className="hat-tassel">
          <path className="hat-cord" d="M 93.5 25.5 Q 95.5 33 94 40" />
          <circle className="tassel-knot" cx="94" cy="40.5" r="2" />
          <path className="tassel-tuft" d="M 91.6 41.5 L 90.2 52.5 Q 94 54 97.8 52.5 L 96.4 41.5 Z" />
          <path className="tassel-strands" d="M 92.6 44 L 92 52 M 94 44 L 94 52.8 M 95.4 44 L 96 52" />
        </g>
      </g>
    </g>
  );
}
