import { describe, expect, it } from 'vitest';
import { demuxOggOpus, GRANULE_PER_FRAME, muxOggOpus, oggCrc } from '../../src/main/voice/ogg';

const packet = (n: number, fill: number) => new Uint8Array(n).fill(fill);

describe('ogg', () => {
  it('computes the Ogg CRC (the CRC-32/MPEG-2 check value without the final xor)', () => {
    // CRC-32 poly 0x04c11db7, init 0, unreflected, no final xor ("CRC-32/POSIX" before its ~): 0x89a1897f for "123456789".
    expect(oggCrc(new TextEncoder().encode('123456789'))).toBe(0x89a1897f);
  });

  it('round-trips packets, including ones longer than 255 bytes and pages of many packets', () => {
    const packets = Array.from({ length: 120 }, (_, i) => packet(i === 7 ? 600 : i === 8 ? 255 : 40 + (i % 30), i));
    const file = muxOggOpus(packets, { inputSampleRate: 24000, serial: 7 });
    const { head, packets: out } = demuxOggOpus(file);
    expect(head).toEqual({ channels: 1, preSkip: 312, inputSampleRate: 24000 });
    expect(out.map((p) => p.length)).toEqual(packets.map((p) => p.length));
    expect(out[7]![599]).toBe(7);
    expect(out[8]![254]).toBe(8);
  });

  it('marks the first page BOS and the last EOS, with the trimmed end as its granule', () => {
    const file = muxOggOpus([packet(10, 1), packet(10, 2)], { inputSampleRate: 48000, samples48k: 1000, serial: 1 });
    expect(String.fromCharCode(...file.subarray(0, 4))).toBe('OggS');
    expect(file[5]).toBe(0x02);
    // the last page starts at the last "OggS"
    let last = 0;
    for (let i = 0; i + 3 < file.length; i++) if (file[i] === 0x4f && file[i + 1] === 0x67 && file[i + 2] === 0x67 && file[i + 3] === 0x53) last = i;
    expect(file[last + 5]).toBe(0x04);
    const granule = new DataView(file.buffer, file.byteOffset).getBigUint64(last + 6, true);
    expect(granule).toBe(BigInt(Math.min(2 * GRANULE_PER_FRAME, 312 + 1000)));
  });

  it('skips a page whose checksum is wrong, and rejects what is not Ogg Opus', () => {
    const file = muxOggOpus([packet(10, 1), packet(10, 2)], { inputSampleRate: 48000 });
    expect(() => demuxOggOpus(new TextEncoder().encode('hello'))).toThrow(/Ogg Opus/);
    const broken = file.slice();
    broken[broken.length - 1]! ^= 0xff; // corrupt the audio page
    expect(demuxOggOpus(broken).packets).toEqual([]);
  });
});
