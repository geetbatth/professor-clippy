/**
 * Clippy's sound effects, synthesised with WebAudio (no audio files):
 * `ding` (new note), `boing` (big antics), `tap` (knocking on the glass).
 */
export type SoundName = 'ding' | 'boing' | 'tap';

export interface SoundBoard {
  play(name: SoundName): void;
}

type Synth = (ctx: AudioContext, out: AudioNode, t: number) => void;

/** A short tone with an exponential decay. */
function tone(ctx: AudioContext, out: AudioNode, t: number, freq: number, dur: number, peak: number, type: OscillatorType = 'sine') {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(peak, t + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(out);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

const SYNTHS: Record<SoundName, Synth> = {
  // A little desk bell: two bright partials, then a second, higher strike.
  ding(ctx, out, t) {
    tone(ctx, out, t, 1318.5, 0.9, 0.28);
    tone(ctx, out, t, 2637, 0.5, 0.08);
    tone(ctx, out, t + 0.12, 1760, 1.1, 0.22);
    tone(ctx, out, t + 0.12, 3520, 0.45, 0.05);
  },
  // A cartoon spring: pitch swoops down then wobbles back up.
  boing(ctx, out, t) {
    const osc = ctx.createOscillator();
    const wobble = ctx.createOscillator();
    const wobbleDepth = ctx.createGain();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(420, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.12);
    osc.frequency.exponentialRampToValueAtTime(330, t + 0.55);
    wobble.frequency.setValueAtTime(18, t);
    wobbleDepth.gain.setValueAtTime(40, t);
    wobble.connect(wobbleDepth).connect(osc.frequency);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain).connect(out);
    osc.start(t);
    wobble.start(t);
    osc.stop(t + 0.65);
    wobble.stop(t + 0.65);
  },
  // Three knuckle taps on glass: filtered noise clicks with a glassy ping.
  tap(ctx, out, t) {
    const len = Math.floor(ctx.sampleRate * 0.03);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3;
    // Matches the 3 knocks in the tapGlass animation (27%, 41%, 55% of 1.6 s).
    for (const at of [0.43, 0.66, 0.88]) {
      const src = ctx.createBufferSource();
      const band = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      src.buffer = buffer;
      band.type = 'bandpass';
      band.frequency.value = 2400;
      band.Q.value = 3;
      gain.gain.value = 0.9;
      src.connect(band).connect(gain).connect(out);
      src.start(t + at);
      tone(ctx, out, t + at, 3900, 0.12, 0.04);
    }
  },
};

/** A sound board that only makes noise while `enabled()` is true. The AudioContext is created on first use. */
export function createSoundBoard(enabled: () => boolean): SoundBoard {
  let ctx: AudioContext | undefined;
  let master: GainNode | undefined;
  return {
    play(name) {
      if (!enabled() || typeof AudioContext === 'undefined') return;
      try {
        if (!ctx) {
          ctx = new AudioContext();
          master = ctx.createGain();
          master.gain.value = 0.6;
          master.connect(ctx.destination);
        }
        if (ctx.state === 'suspended') void ctx.resume();
        SYNTHS[name](ctx, master!, ctx.currentTime + 0.02);
      } catch {
        // Sound is a nicety; never let it break the UI.
      }
    },
  };
}
