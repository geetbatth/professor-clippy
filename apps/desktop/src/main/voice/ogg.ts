/**
 * Ogg Opus as voice notes use it (RFC 7845): one mono logical stream. `muxOggOpus` wraps Opus
 * packets from an encoder in Ogg pages; `demuxOggOpus` takes a voice note apart again into its
 * header and Opus packets for a decoder. Pure: no codec here (see `audio.ts` for that).
 */

/** Opus packets of {@link FRAME_MS} each, the frame size `audio.ts` encodes with. */
export const FRAME_MS = 20;
/** Samples per frame at 48 kHz: Ogg Opus granule positions always count at 48 kHz. */
export const GRANULE_PER_FRAME = 48 * FRAME_MS;
/** The usual Opus encoder delay at 48 kHz, written as the stream's pre-skip. */
export const DEFAULT_PRE_SKIP = 312;
/** Packets per page: one second of audio. */
const PACKETS_PER_PAGE = 50;
const VENDOR = 'Professor Clippy';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32 (polynomial 0x04c11db7, not reflected, initial 0). */
export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]!) >>> 0;
  return crc;
}

export interface OpusHead {
  channels: number;
  preSkip: number;
  inputSampleRate: number;
}

export interface MuxOptions {
  /** The encoder's input rate, recorded in the header (informational). */
  inputSampleRate: number;
  /** Real audio length at 48 kHz; trims the last frame's padding. Default: every frame counts. */
  samples48k?: number;
  preSkip?: number;
  /** Stream serial number (default random). */
  serial?: number;
}

/** An Ogg Opus file holding `packets` (each {@link FRAME_MS} long, mono). */
export function muxOggOpus(packets: readonly Uint8Array[], options: MuxOptions): Uint8Array {
  const preSkip = options.preSkip ?? DEFAULT_PRE_SKIP;
  const serial = options.serial ?? Math.floor(Math.random() * 0xffffffff);
  const pages: Uint8Array[] = [];
  let seq = 0;
  const page = (data: readonly Uint8Array[], granule: bigint, flags: number) => pages.push(buildPage(data, granule, serial, seq++, flags));

  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set(ascii('OpusHead'));
  head[8] = 1; // version
  head[9] = 1; // channels
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, options.inputSampleRate, true);
  // output gain 0, channel mapping family 0
  page([head], 0n, 0x02);

  const vendor = ascii(VENDOR);
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(ascii('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  // no user comments
  page([tags], 0n, 0);

  const total = packets.length * GRANULE_PER_FRAME;
  const end = options.samples48k === undefined ? total : Math.min(total, preSkip + options.samples48k);
  if (packets.length === 0) {
    page([], 0n, 0x04);
  }
  for (let i = 0; i < packets.length; i += PACKETS_PER_PAGE) {
    const chunk = packets.slice(i, i + PACKETS_PER_PAGE);
    const last = i + chunk.length >= packets.length;
    const granule = last ? end : (i + chunk.length) * GRANULE_PER_FRAME;
    page(chunk, BigInt(granule), last ? 0x04 : 0);
  }
  return concat(pages);
}

function buildPage(packets: readonly Uint8Array[], granule: bigint, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  if (lacing.length > 255) throw new Error('Ogg page has too many segments');
  const body = concat(packets);
  const out = new Uint8Array(27 + lacing.length + body.length);
  const v = new DataView(out.buffer);
  out.set(ascii('OggS'));
  out[4] = 0; // version
  out[5] = flags;
  v.setBigUint64(6, granule, true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  // checksum (22..25) stays 0 while it is computed
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(body, 27 + lacing.length);
  v.setUint32(22, oggCrc(out), true);
  return out;
}

export interface DemuxedOpus {
  head: OpusHead;
  /** The audio packets (the two header packets are not included). */
  packets: Uint8Array[];
}

/**
 * The Opus packets of an Ogg Opus file (the first logical stream; any other is ignored).
 * Throws on something that isn't Ogg Opus. A page with a bad checksum is skipped.
 */
export function demuxOggOpus(bytes: Uint8Array): DemuxedOpus {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const all: Uint8Array[] = [];
  let partial: Uint8Array[] = [];
  let serial: number | undefined;
  let pos = 0;
  while (pos + 27 <= bytes.length) {
    if (!(bytes[pos] === 0x4f && bytes[pos + 1] === 0x67 && bytes[pos + 2] === 0x67 && bytes[pos + 3] === 0x53)) {
      // Not at a page: find the next capture pattern.
      const next = indexOfOggS(bytes, pos + 1);
      if (next < 0) break;
      pos = next;
      continue;
    }
    const segments = bytes[pos + 26]!;
    const headerLen = 27 + segments;
    if (pos + headerLen > bytes.length) break;
    const lacing = bytes.subarray(pos + 27, pos + headerLen);
    const bodyLen = lacing.reduce((a, b) => a + b, 0);
    const pageEnd = pos + headerLen + bodyLen;
    if (pageEnd > bytes.length) break;
    const pageSerial = view.getUint32(pos + 14, true);
    const page = bytes.slice(pos, pageEnd);
    new DataView(page.buffer).setUint32(22, 0, true);
    const crcOk = oggCrc(page) === view.getUint32(pos + 22, true);
    serial ??= pageSerial;
    if (crcOk && pageSerial === serial) {
      const continued = (bytes[pos + 5]! & 0x01) !== 0;
      if (!continued) partial = [];
      let off = pos + headerLen;
      for (const len of lacing) {
        partial.push(bytes.subarray(off, off + len));
        off += len;
        if (len < 255) {
          all.push(concat(partial));
          partial = [];
        }
      }
    }
    pos = pageEnd;
  }
  const [headPacket, , ...packets] = all;
  if (!headPacket || headPacket.length < 19 || text(headPacket.subarray(0, 8)) !== 'OpusHead') {
    throw new Error('Not an Ogg Opus voice note');
  }
  const hv = new DataView(headPacket.buffer, headPacket.byteOffset, headPacket.byteLength);
  return {
    head: { channels: headPacket[9]!, preSkip: hv.getUint16(10, true), inputSampleRate: hv.getUint32(12, true) },
    packets,
  };
}

function indexOfOggS(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 3 < bytes.length; i++) {
    if (bytes[i] === 0x4f && bytes[i + 1] === 0x67 && bytes[i + 2] === 0x67 && bytes[i + 3] === 0x53) return i;
  }
  return -1;
}

function ascii(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function text(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
