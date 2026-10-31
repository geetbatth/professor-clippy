/**
 * Utility-process entry (`out/main/voiceChild.js`): runs the speech models (sherpa-onnx), so
 * their memory belongs to a process main can end. Main posts {@link VoiceJob}s one at a time
 * and kills this process once it has been idle for a while (`voiceProcess.ts`), which is what
 * gives the memory back. Models load on first use and stay loaded until then.
 */
import sherpa from 'sherpa-onnx-node';
import { decodeOggOpus, encodeOggOpus, toWav } from './audio';
import type { ModelPaths } from './models';
import { cleanTranscript, splitForWhisper } from './speech';

export type VoiceJob =
  | { id: number; kind: 'transcribe'; paths: ModelPaths; ogg?: Uint8Array; pcm?: Float32Array; sampleRate?: number }
  | { id: number; kind: 'speak'; paths: ModelPaths; text: string; format: 'ogg' | 'wav'; speakerId: number; speed?: number };

export type VoiceResult =
  | { id: number; ok: true; text: string }
  | { id: number; ok: true; audio: Uint8Array; seconds: number }
  | { id: number; ok: false; error: string };

const THREADS = 4;
const RATE = 16_000;

interface Recognizer {
  createStream(): { acceptWaveform(w: { samples: Float32Array; sampleRate: number }): void };
  decode(stream: unknown): void;
  getResult(stream: unknown): { text: string };
}
interface Tts {
  generate(req: { text: string; sid: number; speed: number; enableExternalBuffer: boolean }): { samples: Float32Array; sampleRate: number };
}

let recognizer: Recognizer | undefined;
let tts: Tts | undefined;

function getRecognizer(paths: ModelPaths): Recognizer {
  recognizer ??= new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: RATE, featureDim: 80 },
    modelConfig: { whisper: { encoder: paths.stt.encoder, decoder: paths.stt.decoder, language: 'en', task: 'transcribe' }, tokens: paths.stt.tokens, numThreads: THREADS },
  }) as Recognizer;
  return recognizer;
}

function getTts(paths: ModelPaths): Tts {
  tts ??= new sherpa.OfflineTts({
    model: { kokoro: { ...paths.tts, lang: 'en-us' }, numThreads: THREADS },
    maxNumSentences: 1,
  }) as Tts;
  return tts;
}

function transcribe(job: Extract<VoiceJob, { kind: 'transcribe' }>): string {
  let samples: Float32Array;
  if (job.ogg) samples = decodeOggOpus(job.ogg, RATE);
  else if (job.pcm && job.sampleRate === RATE) samples = job.pcm;
  else throw new Error('Nothing to transcribe.');
  const rec = getRecognizer(job.paths);
  const parts: string[] = [];
  for (const chunk of splitForWhisper(samples, RATE)) {
    if (chunk.length < RATE / 4) continue; // under a quarter second: nothing said
    const stream = rec.createStream();
    stream.acceptWaveform({ samples: chunk, sampleRate: RATE });
    rec.decode(stream);
    parts.push(rec.getResult(stream).text);
  }
  return cleanTranscript(parts.join(' '));
}

function speak(job: Extract<VoiceJob, { kind: 'speak' }>): { audio: Uint8Array; seconds: number } {
  const { samples, sampleRate } = getTts(job.paths).generate({
    text: job.text,
    sid: job.speakerId,
    speed: job.speed ?? 1,
    // Electron's V8 memory cage refuses buffers allocated outside it: have the addon copy the audio in.
    enableExternalBuffer: false,
  });
  const audio = job.format === 'ogg' ? encodeOggOpus(samples, sampleRate) : toWav(samples, sampleRate);
  return { audio, seconds: samples.length / sampleRate };
}

const port = process.parentPort;
port.on('message', (e: Electron.MessageEvent) => {
  const job = e.data as VoiceJob;
  let result: VoiceResult;
  try {
    result = job.kind === 'transcribe' ? { id: job.id, ok: true, text: transcribe(job) } : { id: job.id, ok: true, ...speak(job) };
  } catch (err) {
    result = { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  port.postMessage(result);
});
