import './Eyebrows.css';

/** One brow: a dark outline pass, then the white fluff on top. */
function Brow({ main, hair }: { main: string; hair: string }) {
  return (
    <>
      <path className="brow-outline" d={main} />
      <path className="brow-hair-outline" d={hair} />
      <path className="brow-main" d={main} />
      <path className="brow-hair" d={hair} />
    </>
  );
}

/** Big, white, bushy professorial eyebrows, each with a few unruly hairs. */
export function Eyebrows() {
  return (
    <g className="clippy-brows">
      <g className="brow brow-l">
        <Brow main="M 44 46.5 Q 51 38.5 63.5 41.5" hair="M 46.5 43.5 l -2.6 -3.2 M 52.5 40.4 l -0.8 -3.6 M 58.5 39.8 l 1 -3.4 M 62.5 41 l 3 -2.2" />
      </g>
      <g className="brow brow-r">
        <Brow main="M 98 45.5 Q 90 37 77.5 40.5" hair="M 95.5 42.4 l 2.6 -3.2 M 89.5 39.2 l 0.8 -3.6 M 83 39 l -1 -3.4 M 78.8 40.3 l -3 -2.2" />
      </g>
    </g>
  );
}
