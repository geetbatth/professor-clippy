import './Mouth.css';

/** One mouth per expression; CSS shows the one for the current mood. */
export function Mouth() {
  return (
    <g className="clippy-mouth">
      <ellipse className="cheek" cx="51" cy="80" rx="4.2" ry="2.4" />
      <ellipse className="cheek" cx="91" cy="79" rx="4.2" ry="2.4" />
      <path className="mouth mouth-smile" d="M 63.5 82 Q 71 89 78.5 81.5" />
      <ellipse className="mouth mouth-o" cx="71" cy="85" rx="3.4" ry="4.4" />
      <g className="mouth mouth-grin">
        <path className="grin-mouth" d="M 61.5 81 Q 71 95 80.5 80.5 Q 71 84 61.5 81 Z" />
        <path className="grin-tongue" d="M 66.5 87.6 Q 71 85.4 75.4 87.4 Q 71 91.5 66.5 87.6 Z" />
      </g>
      <path className="mouth mouth-flat" d="M 65 85 Q 71 82.8 77 84.6" />
      <path className="mouth mouth-hmm" d="M 66 85.5 Q 70 84 73 85 Q 75.5 85.8 77.5 84" />
      <ellipse className="mouth mouth-snore" cx="71" cy="85" rx="2.4" ry="1.7" />
    </g>
  );
}
