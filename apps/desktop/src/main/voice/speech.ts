/**
 * Pure helpers around the speech models: what of a reply is worth reading aloud, and how a
 * long recording is cut for Whisper, which hears at most 30 seconds at a time.
 */

/** A phone reply longer than this (spoken characters) goes as text only: nobody wants a two-minute robot voice note. */
export const PHONE_SPEAK_MAX_CHARS = 700;
/** A note read aloud on the phone may be longer: an agent's "finished" summary often is (about 90 seconds). */
export const NOTE_SPEAK_MAX_CHARS = 1500;
/** The desk's speaker button reads at most this much. */
export const DESK_SPEAK_MAX_CHARS = 4000;

/**
 * `text` as it should be spoken: markdown, links, code and emoji removed, whitespace tidied.
 * Empty when nothing speakable is left.
 */
export function speakableText(text: string): string {
  return (
    text
      // code blocks and inline code: read the words inside, not the backticks
      .replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1')
      .replace(/`([^`]*)`/g, '$1')
      // [label](url) -> label; bare URLs -> "a link"
      .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
      .replace(/\bhttps?:\/\/\S+/gi, 'a link')
      // markdown emphasis, headings, quotes and bullets
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
      .replace(/^\s{0,3}(#{1,6}|>|[-*•]|\d+[.)])\s+/gm, '')
      // emoji and other pictographs (and the joiners / variation selectors around them)
      .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
      // paragraph breaks become sentence breaks
      .replace(/([^.!?:;,\s])\s*\n\s*\n\s*/g, '$1. ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/** Whisper's window is 30 s; chunks are kept under this so nothing is cut off. */
const MAX_CHUNK_S = 28;
/** A cut is made in the quietest moment of the last few seconds before the limit. */
const SEARCH_S = 8;
const WINDOW_S = 0.1;

/**
 * Cut a long recording (mono, `sampleRate`) into pieces of at most {@link MAX_CHUNK_S}
 * seconds for Whisper, each cut in the quietest 0.1 s of the {@link SEARCH_S} seconds before
 * the limit, so words are rarely split. Short recordings come back whole.
 */
export function splitForWhisper(samples: Float32Array, sampleRate: number): Float32Array[] {
  const max = Math.floor(MAX_CHUNK_S * sampleRate);
  const chunks: Float32Array[] = [];
  let start = 0;
  while (samples.length - start > max) {
    const win = Math.max(1, Math.floor(WINDOW_S * sampleRate));
    const from = start + max - Math.floor(SEARCH_S * sampleRate);
    let best = start + max;
    let bestEnergy = Infinity;
    for (let at = from; at + win <= start + max; at += win) {
      let e = 0;
      for (let i = at; i < at + win; i++) e += samples[i]! * samples[i]!;
      if (e < bestEnergy) {
        bestEnergy = e;
        best = at + Math.floor(win / 2);
      }
    }
    chunks.push(samples.subarray(start, best));
    start = best;
  }
  chunks.push(samples.subarray(start));
  return chunks;
}

/** Whisper's transcript, tidied: its "[BLANK_AUDIO]"-style tags and stray whitespace removed. */
export function cleanTranscript(text: string): string {
  return text
    .replace(/\[[A-Z _]+\]|\((?:music|silence|inaudible|blank audio)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
