/**
 * Audio conversions for voice notes: PCM to an Ogg Opus voice note and back (libopus via
 * `@evan/opus`), and PCM to a WAV file for the desk's speaker button. Runs in the voice
 * utility process (`voiceChild.ts`), never in main.
 */
import { Decoder, Encoder } from '@evan/opus';
import { demuxOggOpus, FRAME_MS, muxOggOpus } from './ogg';

type OpusRate = 8000 | 12000 | 16000 | 24000 | 48000;
const OPUS_RATES: readonly number[] = [8000, 12000, 16000, 24000, 48000];
/** Speech at this bitrate sounds clear and keeps a minute of voice note around 200 KB. */
const VOICE_BITRATE = 24_000;

/** Mono `samples` (-1..1) at `sampleRate` as an Ogg Opus voice note. */
export function encodeOggOpus(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!OPUS_RATES.includes(sampleRate)) throw new Error(`Opus can't encode ${sampleRate} Hz audio`);
  const encoder = new Encoder({ channels: 1, sample_rate: sampleRate as OpusRate, application: 'voip' });
  encoder.bitrate = VOICE_BITRATE;
  encoder.signal = 'voice';
  const frame = (sampleRate * FRAME_MS) / 1000;
  const packets: Uint8Array[] = [];
  const pcm = new Int16Array(frame);
  for (let i = 0; i < samples.length; i += frame) {
    pcm.fill(0);
    const n = Math.min(frame, samples.length - i);
    for (let j = 0; j < n; j++) pcm[j] = toInt16(samples[i + j]!);
    packets.push(Uint8Array.from(encoder.encode(pcm)));
  }
  return muxOggOpus(packets, { inputSampleRate: sampleRate, samples48k: Math.round((samples.length * 48_000) / sampleRate) });
}

/** An Ogg Opus voice note as mono samples (-1..1) at `sampleRate` (16 kHz for speech recognition). */
export function decodeOggOpus(bytes: Uint8Array, sampleRate: OpusRate = 16_000): Float32Array {
  const { head, packets } = demuxOggOpus(bytes);
  const channels = head.channels === 2 ? 2 : 1;
  const decoder = new Decoder({ channels, sample_rate: sampleRate });
  const chunks: Int16Array[] = [];
  let total = 0;
  for (const packet of packets) {
    if (packet.length === 0) continue;
    let out: Uint8Array;
    try {
      out = decoder.decode(packet);
    } catch {
      continue; // one damaged packet: skip it rather than lose the note
    }
    const pcm = new Int16Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    chunks.push(pcm);
    total += pcm.length / channels;
  }
  const skip = Math.min(total, Math.round((head.preSkip * sampleRate) / 48_000));
  const result = new Float32Array(total - skip);
  let frame = 0;
  for (const pcm of chunks) {
    for (let i = 0; i < pcm.length; i += channels) {
      const v = channels === 2 ? (pcm[i]! + pcm[i + 1]!) / 2 : pcm[i]!;
      if (frame >= skip) result[frame - skip] = v / 32768;
      frame++;
    }
  }
  return result;
}

/** Mono samples as a 16-bit PCM WAV file. */
export function toWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(44 + i * 2, toInt16(samples[i]!), true);
  return out;
}

function toInt16(x: number): number {
  const c = Math.max(-1, Math.min(1, x));
  return Math.round(c < 0 ? c * 32768 : c * 32767);
}
