/**
 * Clippy's ears and voice: turns voice notes and desk recordings into text, and text into a
 * voice note (Ogg Opus, for the phone) or a WAV (the desk's speaker button). Everything runs
 * on this PC in the voice utility process (`VoiceEngine`); the two models download once, on
 * first use or from Settings → Voice, and `status()` / `onStatus` say how that is going.
 */
import type { VoiceStatus } from '@clippy/shared';
import { downloadModel, KOKORO_SPEAKER_ID, modelPaths, modelReady, VOICE_DOWNLOAD_BYTES, VOICE_MODELS, type DownloadOptions } from './models';
import { speakableText } from './speech';
import type { VoiceEngine } from './voiceProcess';

/** Voice was used before the models were downloaded (the download has been started). */
export class VoiceNotReadyError extends Error {
  constructor(readonly status: VoiceStatus) {
    super(
      status.state === 'error'
        ? `Clippy's voice models couldn't be downloaded: ${status.error ?? 'unknown error'}`
        : `Clippy is still downloading his voice models (one time, about ${status.downloadMb} MB). Try again in a few minutes.`,
    );
    this.name = 'VoiceNotReadyError';
  }
}

/** Voice is turned off in Settings. */
export class VoiceOffError extends Error {
  constructor() {
    super('Voice is turned off (Settings → Voice).');
    this.name = 'VoiceOffError';
  }
}

export interface VoiceOptions {
  dataDir: string;
  engine: Pick<VoiceEngine, 'run' | 'stop'>;
  enabled: () => boolean;
  onStatus?: (status: VoiceStatus) => void;
  /** Download seams (tests). */
  download?: Pick<DownloadOptions, 'fetch' | 'extract'>;
  log?: (message: string) => void;
}

export interface Spoken {
  audio: Uint8Array;
  seconds: number;
}

export class Voice {
  readonly #o: VoiceOptions;
  #state: VoiceStatus['state'] = 'missing';
  #progress = 0;
  #error: string | undefined;
  #download: Promise<void> | undefined;

  constructor(options: VoiceOptions) {
    this.#o = options;
  }

  /** Read whether the models are on disk (call once at start). */
  async init(): Promise<void> {
    const ready = await this.#modelsReady();
    if (this.#state === 'missing' && ready) this.#set('ready');
  }

  status(): VoiceStatus {
    return {
      enabled: this.#o.enabled(),
      state: this.#state,
      ...(this.#state === 'downloading' && { progress: this.#progress }),
      ...(this.#state === 'error' && this.#error !== undefined && { error: this.#error }),
      downloadMb: Math.round(VOICE_DOWNLOAD_BYTES / 1e6),
    };
  }

  /** Voice was switched on or off: tell the windows. */
  settingsChanged(): void {
    if (!this.#o.enabled()) this.#o.engine.stop();
    this.#emit();
  }

  /** Download the models (once; a call while downloading joins it). Resolves when ready; rejects if it failed. */
  download(): Promise<void> {
    if (this.#state === 'ready') return Promise.resolve();
    this.#download ??= this.#runDownload().finally(() => (this.#download = undefined));
    return this.#download;
  }

  /** What was said in an Ogg Opus voice note (a phone's voice message). */
  transcribeOgg(ogg: Uint8Array): Promise<string> {
    return this.#transcribe({ ogg });
  }

  /** What was said in a desk recording (mono, 16 kHz). */
  transcribePcm(pcm: Float32Array, sampleRate: number): Promise<string> {
    return this.#transcribe({ pcm, sampleRate });
  }

  /**
   * `text` in Clippy's voice, or undefined when there is nothing to say aloud or it is longer
   * than `maxChars` once markdown and emoji are taken out.
   */
  async speak(text: string, format: 'ogg' | 'wav', maxChars: number): Promise<Spoken | undefined> {
    const spoken = speakableText(text);
    if (!spoken || spoken.length > maxChars) return undefined;
    this.#check();
    const r = await this.#o.engine.run({ kind: 'speak', paths: modelPaths(this.#o.dataDir), text: spoken, format, speakerId: KOKORO_SPEAKER_ID });
    if (!('audio' in r)) throw new Error('The voice process sent no audio.');
    return { audio: r.audio, seconds: r.seconds };
  }

  async #transcribe(input: { ogg: Uint8Array } | { pcm: Float32Array; sampleRate: number }): Promise<string> {
    this.#check();
    const r = await this.#o.engine.run({ kind: 'transcribe', paths: modelPaths(this.#o.dataDir), ...input });
    if (!('text' in r)) throw new Error('The voice process sent no text.');
    return r.text;
  }

  /** Throws unless voice is on and the models are here (starting the download if they aren't). */
  #check(): void {
    if (!this.#o.enabled()) throw new VoiceOffError();
    if (this.#state === 'ready') return;
    this.download().catch(() => {}); // the status carries the error
    throw new VoiceNotReadyError(this.status());
  }

  async #runDownload(): Promise<void> {
    this.#error = undefined;
    this.#progress = 0;
    this.#set('downloading');
    let before = 0;
    try {
      for (const spec of VOICE_MODELS) {
        await downloadModel(spec, {
          dataDir: this.#o.dataDir,
          ...this.#o.download,
          onProgress: (done) => {
            const progress = Math.min(1, (before + done) / VOICE_DOWNLOAD_BYTES);
            // Settings shows whole percents: no need to tell the windows more often.
            if (Math.floor(progress * 100) !== Math.floor(this.#progress * 100)) {
              this.#progress = progress;
              this.#emit();
            }
          },
        });
        before += spec.bytes;
      }
      this.#o.log?.('voice: models downloaded');
      this.#set('ready');
    } catch (err) {
      this.#error = err instanceof Error ? err.message : String(err);
      this.#o.log?.(`voice: model download failed: ${this.#error}`);
      this.#set('error');
      throw err;
    }
  }

  async #modelsReady(): Promise<boolean> {
    for (const spec of VOICE_MODELS) if (!(await modelReady(this.#o.dataDir, spec))) return false;
    return true;
  }

  #set(state: VoiceStatus['state']): void {
    this.#state = state;
    this.#emit();
  }

  #emit(): void {
    this.#o.onStatus?.(this.status());
  }
}
