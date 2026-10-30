/**
 * Stream-json fixtures for the brain tests. Nothing here runs the real `claude` CLI.
 *
 * - `pong.jsonl`, `not-logged-in.jsonl`, `resume-missing.jsonl`: recorded from Claude Code
 *   2.1.312 (`claude -p --output-format stream-json --verbose [--include-partial-messages]`,
 *   prompt "Reply with exactly the word: pong", no tools), trimmed of usage/rate-limit noise.
 * - `tool-turn.jsonl`, `no-partials.jsonl`: hand-built in the same shape (a tool call between two
 *   text blocks, a subagent line; and a run without partial messages).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClaudeRunner, ClaudeRunRequest, ClaudeRunResult } from '../../src/main/brain/runner';

export type FixtureName = 'pong' | 'not-logged-in' | 'resume-missing' | 'tool-turn' | 'no-partials';

export function fixture(name: FixtureName): string {
  return readFileSync(join(import.meta.dirname, 'fixtures', `${name}.jsonl`), 'utf8');
}

export interface ScriptedRun {
  /** stdout to replay (split into small chunks to exercise line reassembly). */
  stdout?: string;
  result?: Partial<ClaudeRunResult>;
  /** Hold the run open until `release()` is called (for queue tests). */
  hold?: boolean;
}

export interface FakeRunner {
  runner: ClaudeRunner;
  calls: ClaudeRunRequest[];
  /** Finish the oldest held run. */
  release(): void;
  killed: number;
}

/** A runner that replays one scripted run per call, in order. */
export function fakeRunner(script: ScriptedRun[]): FakeRunner {
  const calls: ClaudeRunRequest[] = [];
  const held: (() => void)[] = [];
  const state = { killed: 0 };
  const runner: ClaudeRunner = (request, onStdout) => {
    calls.push(request);
    const step = script.shift() ?? { stdout: fixture('pong') };
    let finish!: (r: ClaudeRunResult) => void;
    const done = new Promise<ClaudeRunResult>((r) => (finish = r));
    const play = () => {
      const out = step.stdout ?? '';
      for (let i = 0; i < out.length; i += 37) onStdout(out.slice(i, i + 37));
      finish({ code: 0, stderr: '', ...step.result });
    };
    if (step.hold) held.push(play);
    else queueMicrotask(play);
    return {
      done,
      kill() {
        state.killed++;
        finish({ code: null, stderr: '' });
      },
    };
  };
  return {
    runner,
    calls,
    release: () => held.shift()?.(),
    get killed() {
      return state.killed;
    },
  };
}
