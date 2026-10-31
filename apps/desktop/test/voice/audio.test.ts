import { describe, expect, it } from 'vitest';
import { decodeOggOpus, encodeOggOpus, toWav } from '../../src/main/voice/audio';

function tone(seconds: number, rate: number, hz = 440): Float32Array {
  const s = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < s.length; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
  return s;
}

describe('audio', () => {
  it('encodes a voice note that decodes back to about the same length and loudness', () => {
    const ogg = encodeOggOpus(tone(1.5, 24000), 24000);
    expect(ogg.length).toBeLessThan(10_000);
    const pcm = decodeOggOpus(ogg, 16000);
    expect(Math.abs(pcm.length - 1.5 * 16000)).toBeLessThan(400);
    const rms = Math.sqrt(pcm.slice(2000, 20000).reduce((a, x) => a + x * x, 0) / 18000);
    expect(rms).toBeGreaterThan(0.25);
    expect(rms).toBeLessThan(0.45);
  });

  it('refuses a sample rate Opus does not take', () => {
    expect(() => encodeOggOpus(tone(0.1, 22050), 22050)).toThrow(/22050/);
  });

  it('writes a 16-bit mono WAV', () => {
    const wav = toWav(Float32Array.from([0, 1, -1]), 24000);
    const v = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
    expect(v.getUint32(24, true)).toBe(24000);
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 32767, -32768]);
  });
});
