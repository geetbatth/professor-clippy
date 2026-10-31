/**
 * Records the microphone as mono 16 kHz samples, the rate the speech model hears at (Chromium
 * resamples into a 16 kHz AudioContext). Nothing leaves the PC: the samples go to main, which
 * transcribes them in the voice process.
 */

export const RECORD_RATE = 16_000;
/** A recording stops itself after this long. */
export const MAX_RECORD_MS = 120_000;

export interface Recording {
  /** Stop and get what was recorded. */
  stop(): Promise<Float32Array>;
  /** Stop and throw it away. */
  cancel(): void;
  /** Loudness of the last chunk, 0 to 1 (for the mic's pulse). */
  level(): number;
}

/** Start recording; rejects if there is no microphone or it may not be used. */
export async function startRecording(onAutoStop?: () => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: RECORD_RATE });
  const source = ctx.createMediaStreamSource(stream);
  // ScriptProcessor is old but needs no worklet module (the page's CSP allows only its own scripts).
  const node = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  let level = 0;
  node.onaudioprocess = (e) => {
    const data = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(data));
    let peak = 0;
    for (const x of data) peak = Math.max(peak, Math.abs(x));
    level = Math.min(1, peak * 2);
  };
  source.connect(node);
  node.connect(ctx.destination); // a ScriptProcessor only runs while connected; it outputs silence
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    node.disconnect();
    source.disconnect();
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };
  const timer = setTimeout(() => onAutoStop?.(), MAX_RECORD_MS);
  return {
    async stop() {
      close();
      const out = new Float32Array(chunks.reduce((a, c) => a + c.length, 0));
      let off = 0;
      for (const c of chunks) {
        out.set(c, off);
        off += c.length;
      }
      return out;
    },
    cancel: close,
    level: () => level,
  };
}
