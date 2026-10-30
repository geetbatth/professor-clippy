/**
 * Professor Clippy's skeleton: the coordinates every part is drawn around (SVG user units).
 * The viewBox leaves headroom above the hat for jumps and hat tosses.
 */
export const VIEWBOX = { x: -5, y: -24, width: 150, height: 184 } as const;
export const VIEWBOX_ATTR = `${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.width} ${VIEWBOX.height}`;

/** A gem clip standing up: outer bottom bend, top bend (the head), inner bottom bend. */
export const WIRE_PATH = 'M 92 62 L 92 133 A 21 21 0 0 1 50 133 L 50 52 A 17 17 0 0 1 84 52 L 84 124 A 11 11 0 0 1 62 124 L 62 80';

/** Googly eyes: deliberately not quite the same size. */
export const EYES = [
  { cx: 56, cy: 62, r: 10.5 },
  { cx: 85, cy: 61, r: 11.5 },
] as const;
export const PUPIL_R = 4.6;

/** Where each arm joins the wire. */
export const SHOULDER_L = { x: 50, y: 106 } as const;
export const SHOULDER_R = { x: 92, y: 106 } as const;
