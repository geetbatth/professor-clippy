import { EYES } from '../rig';
import './Glasses.css';

const RIM = 2.2;

/** Round tortoiseshell spectacles, perched a touch crooked. */
export function Glasses() {
  const [l, r] = EYES;
  const lr = l.r + RIM;
  const rr = r.r + RIM;
  return (
    <g className="clippy-glasses">
      <g className="glasses-frame">
        <path className="glasses-temple" d={`M ${l.cx - lr} ${l.cy - 1} L ${l.cx - lr - 5} ${l.cy - 3.5}`} />
        <path className="glasses-temple" d={`M ${r.cx + rr} ${r.cy - 1} L ${r.cx + rr + 5} ${r.cy - 3.5}`} />
        <path
          className="glasses-bridge"
          d={`M ${l.cx + lr - 0.5} ${l.cy - 2} Q ${(l.cx + lr + r.cx - rr) / 2} ${l.cy - 6.5} ${r.cx - rr + 0.5} ${r.cy - 2}`}
        />
        {[
          { e: l, rad: lr },
          { e: r, rad: rr },
        ].map(({ e, rad }, i) => (
          <g key={i}>
            <circle className="glasses-lens" cx={e.cx} cy={e.cy} r={rad} />
            <path
              className="glasses-glare"
              d={`M ${e.cx - rad * 0.62} ${e.cy - rad * 0.12} A ${rad * 0.66} ${rad * 0.66} 0 0 1 ${e.cx - rad * 0.1} ${e.cy - rad * 0.64}`}
            />
          </g>
        ))}
      </g>
    </g>
  );
}
