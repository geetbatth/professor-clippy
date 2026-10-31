import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { VoiceStatus } from '@clippy/shared';
import { STT_MODEL, TTS_MODEL, voiceDir } from '../../src/main/voice/models';
import { Voice, VoiceNotReadyError, VoiceOffError } from '../../src/main/voice/voice';
import type { VoiceJobInput } from '../../src/main/voice/voiceProcess';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup(options: { enabled?: boolean; failUrl?: string } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'clippy-voice-'));
  dirs.push(dataDir);
  const jobs: VoiceJobInput[] = [];
  const statuses: VoiceStatus[] = [];
  const fetched: string[] = [];
  const voice = new Voice({
    dataDir,
    enabled: () => options.enabled ?? true,
    onStatus: (s) => statuses.push(s),
    engine: {
      run: async (job) => {
        jobs.push(job);
        return job.kind === 'speak' ? { id: 1, ok: true, audio: new Uint8Array([1]), seconds: 1.5 } : { id: 1, ok: true, text: 'hello there' };
      },
      stop: () => {},
    },
    download: {
      fetch: (async (url: string) => {
        fetched.push(url);
        if (url === options.failUrl) return new Response('nope', { status: 404 });
        return new Response(new Uint8Array(1000), { headers: { 'content-length': '1000' } });
      }) as unknown as typeof fetch,
      // A fake unpack: lays out the archive's root folder with the members asked for.
      extract: async (_archive, dest, members) => {
        for (const m of members) {
          mkdirSync(join(dest, m, '..'), { recursive: true });
          writeFileSync(join(dest, m), 'x');
        }
      },
    },
  });
  return { voice, dataDir, jobs, statuses, fetched };
}

describe('Voice', () => {
  it('starts missing; using it starts the download and says so; once ready, it works', async () => {
    const t = setup();
    await t.voice.init();
    expect(t.voice.status()).toMatchObject({ enabled: true, state: 'missing', downloadMb: 558 });
    await expect(t.voice.transcribeOgg(new Uint8Array([1]))).rejects.toBeInstanceOf(VoiceNotReadyError);
    await t.voice.download();
    expect(t.fetched).toEqual([STT_MODEL.url, TTS_MODEL.url]);
    expect(t.voice.status().state).toBe('ready');
    expect(t.statuses.map((s) => s.state)).toContain('downloading');
    expect(existsSync(join(voiceDir(t.dataDir), 'kokoro-v1.0', 'model.onnx'))).toBe(true);
    expect(JSON.parse(readFileSync(join(voiceDir(t.dataDir), 'whisper-base.en', 'ready.json'), 'utf8')).url).toBe(STT_MODEL.url);
    // No archive or partial download is left behind.
    expect(existsSync(join(voiceDir(t.dataDir), 'kokoro-v1.0.tar.bz2'))).toBe(false);
    expect(existsSync(join(voiceDir(t.dataDir), 'kokoro-v1.0.tar.bz2.part'))).toBe(false);

    expect(await t.voice.transcribeOgg(new Uint8Array([1]))).toBe('hello there');
    expect(await t.voice.speak('**Hello** 👋', 'ogg', 100)).toEqual({ audio: new Uint8Array([1]), seconds: 1.5 });
    expect(t.jobs.at(-1)).toMatchObject({ kind: 'speak', text: 'Hello', format: 'ogg', speakerId: 3 });

    // A new start finds the models on disk.
    const again = new Voice({ dataDir: t.dataDir, enabled: () => true, engine: { run: async () => ({ id: 1, ok: true, text: '' }), stop: () => {} } });
    await again.init();
    expect(again.status().state).toBe('ready');
  });

  it('says nothing when there is nothing to say, or too much', async () => {
    const t = setup();
    await t.voice.download();
    expect(await t.voice.speak('🎉', 'wav', 100)).toBeUndefined();
    expect(await t.voice.speak('word '.repeat(50), 'wav', 100)).toBeUndefined();
    expect(t.jobs).toEqual([]);
  });

  it('refuses while voice is off', async () => {
    const t = setup({ enabled: false });
    await t.voice.download();
    await expect(t.voice.transcribePcm(new Float32Array(1), 16000)).rejects.toBeInstanceOf(VoiceOffError);
  });

  it('a failed download is an error status with the reason; what did download is kept', async () => {
    const t = setup({ failUrl: TTS_MODEL.url });
    await expect(t.voice.download()).rejects.toThrow(/HTTP 404/);
    expect(t.voice.status()).toMatchObject({ state: 'error', error: expect.stringMatching(/voice model failed \(HTTP 404\)/) });
    expect(existsSync(join(voiceDir(t.dataDir), 'whisper-base.en', 'ready.json'))).toBe(true);
  });
});
