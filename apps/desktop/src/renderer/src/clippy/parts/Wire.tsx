import { WIRE_PATH } from '../rig';
import './Wire.css';

/** The steel paperclip body: dark outline, steel stroke, and a broken highlight on top. */
export function Wire() {
  return (
    <g className="clippy-wire">
      <path d={WIRE_PATH} className="wire-outline" />
      <path d={WIRE_PATH} className="wire-steel" />
      <path d={WIRE_PATH} className="wire-shine" />
    </g>
  );
}

/** Shared gradients for the rig. */
export function ClippyDefs() {
  return (
    <defs>
      <linearGradient id="clippy-steel" x1="0" y1="0" x2="1" y2="0.25">
        <stop offset="0" stopColor="#f3f6f9" />
        <stop offset="0.35" stopColor="#c9d1db" />
        <stop offset="0.6" stopColor="#97a3b2" />
        <stop offset="1" stopColor="#dde3ea" />
      </linearGradient>
      <radialGradient id="clippy-eyeball" cx="0.4" cy="0.35" r="0.75">
        <stop offset="0.6" stopColor="#ffffff" />
        <stop offset="1" stopColor="#dfe4ea" />
      </radialGradient>
      <linearGradient id="clippy-gold" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffd75e" />
        <stop offset="1" stopColor="#d99a1e" />
      </linearGradient>
      <filter id="clippy-soft" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="1.6" />
      </filter>
    </defs>
  );
}
