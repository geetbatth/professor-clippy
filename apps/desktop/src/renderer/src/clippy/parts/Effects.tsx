import type { CSSProperties } from 'react';
import './Effects.css';

/** Mood props that travel with Clippy: snoozing Zs, thought bubbles, alarm marks, knock-knock. */
export function Effects() {
  return (
    <g className="clippy-effects">
      <g className="fx-zzz">
        <text x="98" y="30" className="fx-z z1">z</text>
        <text x="98" y="30" className="fx-z z2">z</text>
        <text x="98" y="30" className="fx-z z3">Z</text>
      </g>
      <g className="fx-thought">
        <circle className="fx-dot d1" cx="101" cy="45" r="2.2" />
        <circle className="fx-dot d2" cx="107" cy="35" r="3.2" />
        <g className="fx-cloud">
          <path d="M 105 25 a 6 6 0 0 1 8 -9 a 7 7 0 0 1 12 1 a 6 6 0 0 1 3 10 a 6 6 0 0 1 -9 4 a 7 7 0 0 1 -14 -6 Z" />
          <text x="116" y="26.5">?</text>
        </g>
      </g>
      <g className="fx-alarm">
        <text x="106" y="22" className="fx-bang">!</text>
        <text x="114" y="16" className="fx-bang second">!</text>
      </g>
      <g className="fx-knock">
        <text x="111" y="68" className="fx-knock-text">knock</text>
        <text x="112" y="108" className="fx-knock-text second">knock!</text>
      </g>
    </g>
  );
}

const CONFETTI_COLOURS = ['#ff5a5f', '#ffc93c', '#2ec4b6', '#5b8def', '#b76cf0', '#ff8c42'];

/** Burst pieces: direction (dx, dy), spin and delay are per piece. */
const PIECES = Array.from({ length: 18 }, (_, i) => {
  const angle = (-170 + (160 / 17) * i) * (Math.PI / 180);
  const dist = 38 + ((i * 37) % 23);
  return {
    dx: Math.cos(angle) * dist,
    dy: Math.sin(angle) * dist,
    rot: ((i * 97) % 360) - 180,
    delay: (i % 4) * 45,
    colour: CONFETTI_COLOURS[i % CONFETTI_COLOURS.length]!,
    round: i % 3 === 0,
  };
});

/** Celebration confetti, fixed in the scene (it doesn't jump with Clippy). */
export function Confetti() {
  return (
    <g className="clippy-confetti">
      {PIECES.map((p, i) => {
        const style = {
          '--dx': `${p.dx.toFixed(1)}px`,
          '--dy': `${p.dy.toFixed(1)}px`,
          '--rot': `${p.rot}deg`,
          animationDelay: `${p.delay}ms`,
          fill: p.colour,
        } as CSSProperties;
        return p.round ? (
          <circle key={i} className="confetti" cx="71" cy="40" r="2" style={style} />
        ) : (
          <rect key={i} className="confetti" x="69.5" y="38" width="3" height="5" rx="0.6" style={style} />
        );
      })}
    </g>
  );
}
