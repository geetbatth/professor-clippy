/**
 * The two speech models, downloaded the first time voice is used rather than shipped in the
 * installer: Whisper base.en (speech to text, int8) and Kokoro v1.0 (text to speech), both in
 * sherpa-onnx's packaging from its GitHub releases. Each lives in its own folder under
 * `<data dir>/voice/`, with a `ready.json` written only after it unpacked completely, so a
 * download cut short never counts as installed.
 */
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const RELEASES = 'https://github.com/k2-fsa/sherpa-onnx/releases/download';

export interface ModelSpec {
  id: 'stt' | 'tts';
  /** Folder name under `<data dir>/voice/`. */
  dir: string;
  url: string;
  /** Download size, for progress before the server says (and to show in Settings). */
  bytes: number;
  /** Folder at the top of the archive. */
  root: string;
  /** What to unpack (relative to `root`); the rest of the archive is skipped. */
  keep: readonly string[];
}

export const STT_MODEL: ModelSpec = {
  id: 'stt',
  dir: 'whisper-base.en',
  url: `${RELEASES}/asr-models/sherpa-onnx-whisper-base.en.tar.bz2`,
  bytes: 208_576_005,
  root: 'sherpa-onnx-whisper-base.en',
  keep: ['base.en-encoder.int8.onnx', 'base.en-decoder.int8.onnx', 'base.en-tokens.txt'],
};

export const TTS_MODEL: ModelSpec = {
  id: 'tts',
  dir: 'kokoro-v1.0',
  url: `${RELEASES}/tts-models/kokoro-multi-lang-v1_0.tar.bz2`,
  bytes: 349_886_476,
  root: 'kokoro-multi-lang-v1_0',
  keep: ['model.onnx', 'voices.bin', 'tokens.txt', 'lexicon-us-en.txt', 'espeak-ng-data', 'LICENSE'],
};

export const VOICE_MODELS = [STT_MODEL, TTS_MODEL] as const;
/** Everything there is to download, in bytes. */
export const VOICE_DOWNLOAD_BYTES = VOICE_MODELS.reduce((a, m) => a + m.bytes, 0);

/** Kokoro's "Heart" voice (`af_heart`), the one Clippy speaks with. */
export const KOKORO_SPEAKER_ID = 3;

/** File paths the voice process loads (see `voiceChild.ts`). */
export interface ModelPaths {
  stt: { encoder: string; decoder: string; tokens: string };
  tts: { model: string; voices: string; tokens: string; lexicon: string; dataDir: string };
}

export function voiceDir(dataDir: string): string {
  return join(dataDir, 'voice');
}

export function modelPaths(dataDir: string): ModelPaths {
  const stt = join(voiceDir(dataDir), STT_MODEL.dir);
  const tts = join(voiceDir(dataDir), TTS_MODEL.dir);
  return {
    stt: { encoder: join(stt, 'base.en-encoder.int8.onnx'), decoder: join(stt, 'base.en-decoder.int8.onnx'), tokens: join(stt, 'base.en-tokens.txt') },
    tts: {
      model: join(tts, 'model.onnx'),
      voices: join(tts, 'voices.bin'),
      tokens: join(tts, 'tokens.txt'),
      lexicon: join(tts, 'lexicon-us-en.txt'),
      dataDir: join(tts, 'espeak-ng-data'),
    },
  };
}

/** Is this model unpacked completely? */
export async function modelReady(dataDir: string, spec: ModelSpec): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(voiceDir(dataDir), spec.dir, 'ready.json'), 'utf8')) as { url?: unknown };
    return marker.url === spec.url;
  } catch {
    return false;
  }
}

export interface DownloadOptions {
  dataDir: string;
  /** Bytes downloaded so far of this model, and its size. */
  onProgress?: (done: number, total: number) => void;
  fetch?: typeof fetch;
  /** Unpack `archive` into `dest` (default: Windows' own `tar.exe`). */
  extract?: (archive: string, dest: string, members: readonly string[]) => Promise<void>;
  signal?: AbortSignal;
}

/** Download and unpack one model (does nothing if it is ready already). */
export async function downloadModel(spec: ModelSpec, options: DownloadOptions): Promise<void> {
  const { dataDir } = options;
  if (await modelReady(dataDir, spec)) return;
  const base = voiceDir(dataDir);
  const dest = join(base, spec.dir);
  const archive = join(base, `${spec.dir}.tar.bz2`);
  const part = `${archive}.part`;
  await mkdir(base, { recursive: true });
  await rm(dest, { recursive: true, force: true });

  const doFetch = options.fetch ?? globalThis.fetch;
  const res = await doFetch(spec.url, { ...(options.signal && { signal: options.signal }) });
  if (!res.ok || !res.body) throw new Error(`Downloading the ${spec.id === 'stt' ? 'speech recognition' : 'voice'} model failed (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || spec.bytes;
  let done = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      const now = Date.now();
      if (now - lastReport > 250) {
        lastReport = now;
        options.onProgress?.(done, total);
      }
      cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), counter, createWriteStream(part), {
      ...(options.signal && { signal: options.signal }),
    });
    options.onProgress?.(done, total);
    if ((await stat(part)).size < total) throw new Error('The download was cut short.');
    await rename(part, archive);
    await rm(join(base, spec.root), { recursive: true, force: true }); // left by an earlier failed unpack
    await (options.extract ?? extractWithTar)(archive, base, spec.keep.map((k) => `${spec.root}/${k}`));
    // The archive unpacks to `<root>/...`: move it into place as `<dir>`.
    await rm(dest, { recursive: true, force: true });
    await rename(join(base, spec.root), dest);
    await writeFile(join(dest, 'ready.json'), JSON.stringify({ url: spec.url, at: new Date().toISOString() }));
  } finally {
    await rm(part, { force: true });
    await rm(archive, { force: true });
  }
}

/** Unpack `members` of a .tar.bz2 with the `tar` Windows 10+ ships (bsdtar). */
export function extractWithTar(archive: string, dest: string, members: readonly string[]): Promise<void> {
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xjf', archive, '-C', dest, ...members], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking the model failed (tar exit ${code}): ${err.trim()}`))));
  });
}
