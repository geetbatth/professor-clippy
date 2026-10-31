import { describe, expect, it } from 'vitest';
import type { VoiceResult } from '../../src/main/voice/voiceChild';
import { VoiceEngine, type ChildLike } from '../../src/main/voice/voiceProcess';
import { modelPaths } from '../../src/main/voice/models';

const paths = modelPaths('C:/data');

type Answer = VoiceResult | 'crash' | 'hang';

/** A fake voice process: answers each job after `ms` with `answer(job)`. */
function fakeFork(answer: (job: { id: number; kind: string; text?: string }) => Answer, ms = 5) {
  const forks: string[] = [];
  const fork = (path: string): ChildLike => {
    forks.push(path);
    const handlers: { message?: (r: VoiceResult) => void; exit?: (code: number) => void } = {};
    const child: ChildLike = {
      postMessage(job) {
        const j = job as { id: number; kind: string; text?: string };
        setTimeout(() => {
          const r = answer(j);
          if (r === 'crash') handlers.exit?.(3);
          else if (r !== 'hang') handlers.message?.(r);
        }, ms);
      },
      on(event: 'message' | 'exit', cb: ((r: VoiceResult) => void) | ((code: number) => void)) {
        if (event === 'message') handlers.message = cb as (r: VoiceResult) => void;
        else handlers.exit = cb as (code: number) => void;
        return child;
      },
      kill() {
        setTimeout(() => handlers.exit?.(0), 1);
        return true;
      },
    };
    return child;
  };
  return { fork, forks };
}

const transcribeJob = { kind: 'transcribe' as const, paths, pcm: new Float32Array(1), sampleRate: 16000 };

describe('VoiceEngine', () => {
  it('starts the process on demand, runs jobs in order, and ends it once idle', async () => {
    const order: string[] = [];
    const f = fakeFork((j) => {
      order.push(j.text ?? j.kind);
      return { id: j.id, ok: true, text: `heard ${j.id}` };
    });
    const engine = new VoiceEngine({ fork: f.fork, mainDir: '/out/main', idleMs: 40 });
    expect(engine.running).toBe(false);
    const [a, b] = await Promise.all([
      engine.run({ kind: 'speak', paths, text: 'one', format: 'ogg', speakerId: 3 }),
      engine.run({ kind: 'speak', paths, text: 'two', format: 'ogg', speakerId: 3 }),
    ]);
    expect(order).toEqual(['one', 'two']);
    expect(a).toMatchObject({ ok: true, text: 'heard 1' });
    expect(b).toMatchObject({ ok: true, text: 'heard 2' });
    expect(f.forks).toHaveLength(1);
    expect(f.forks[0]).toMatch(/voiceChild\.js$/);
    expect(engine.running).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    expect(engine.running).toBe(false);
    // The next job starts a fresh process.
    await engine.run(transcribeJob);
    expect(f.forks).toHaveLength(2);
    engine.stop();
  });

  it("rejects with the job's error, when the process dies, and when it hangs; the next job still runs", async () => {
    let n = 0;
    const f = fakeFork((j) => {
      n++;
      if (n === 1) return { id: j.id, ok: false, error: 'bad audio' };
      if (n === 2) return 'crash';
      if (n === 3) return 'hang';
      return { id: j.id, ok: true, text: 'fine' };
    });
    const engine = new VoiceEngine({ fork: f.fork, jobTimeoutMs: 50 });
    await expect(engine.run(transcribeJob)).rejects.toThrow('bad audio');
    await expect(engine.run(transcribeJob)).rejects.toThrow(/stopped unexpectedly \(exit code 3\)/);
    await expect(engine.run(transcribeJob)).rejects.toThrow(/took too long/);
    await expect(engine.run(transcribeJob)).resolves.toMatchObject({ text: 'fine' });
    expect(f.forks).toHaveLength(3);
    engine.stop();
  });
});
