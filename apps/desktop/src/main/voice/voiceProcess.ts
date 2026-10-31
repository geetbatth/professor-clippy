/**
 * Runs speech jobs in the voice utility process (`voiceChild.js`, next to the main bundle):
 * one job at a time, the process started on demand and ended after {@link IDLE_MS} without a
 * job, so the models' few hundred MB are only held while Clippy is listening or speaking.
 */
import { join } from 'node:path';
import type { VoiceJob, VoiceResult } from './voiceChild';

/** Keep the models loaded this long after a job (a voice note in, a voice reply out). */
export const IDLE_MS = 60_000;
/** A job that hasn't finished by now is given up and the process ended. */
export const JOB_TIMEOUT_MS = 180_000;

/** The parts of Electron's `UtilityProcess` used here (tests pass a fake). */
export interface ChildLike {
  postMessage(message: unknown): void;
  on(event: 'message', cb: (message: VoiceResult) => void): unknown;
  on(event: 'exit', cb: (code: number) => void): unknown;
  kill(): boolean;
}

export type Fork = (modulePath: string) => ChildLike;

/** A job as callers pass it (the engine numbers it). */
export type VoiceJobInput = VoiceJob extends infer J ? (J extends VoiceJob ? Omit<J, 'id'> : never) : never;

export interface VoiceEngineOptions {
  fork: Fork;
  mainDir?: string;
  idleMs?: number;
  jobTimeoutMs?: number;
}

export class VoiceEngine {
  readonly #o: VoiceEngineOptions;
  #child: ChildLike | undefined;
  #nextId = 1;
  #chain: Promise<unknown> = Promise.resolve();
  #idle: NodeJS.Timeout | undefined;
  #pending: { id: number; resolve(r: VoiceResult): void } | undefined;

  constructor(options: VoiceEngineOptions) {
    this.#o = options;
  }

  /** Is the process running (models possibly in memory)? */
  get running(): boolean {
    return this.#child !== undefined;
  }

  /** Run `job` after the ones before it. Rejects with the job's error. */
  run(job: VoiceJobInput): Promise<Extract<VoiceResult, { ok: true }>> {
    const result = this.#chain.then(() => this.#runNow(job));
    this.#chain = result.catch(() => {});
    return result;
  }

  /** End the process now (app quit). */
  stop(): void {
    clearTimeout(this.#idle);
    const child = this.#child;
    this.#child = undefined;
    child?.kill();
    const pending = this.#pending;
    if (pending) pending.resolve({ id: pending.id, ok: false, error: 'Voice was stopped.' });
  }

  #runNow(input: VoiceJobInput): Promise<Extract<VoiceResult, { ok: true }>> {
    clearTimeout(this.#idle);
    const child = this.#ensureChild();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending = undefined;
        this.stop();
        clearTimeout(this.#idle);
        reject(new Error('Clippy took too long with that voice note and gave up.'));
      }, this.#o.jobTimeoutMs ?? JOB_TIMEOUT_MS);
      this.#pending = {
        id,
        resolve: (r) => {
          clearTimeout(timer);
          this.#pending = undefined;
          this.#scheduleIdle();
          if (r.ok) resolve(r);
          else reject(new Error(r.error));
        },
      };
      child.postMessage({ ...input, id });
    });
  }

  #ensureChild(): ChildLike {
    if (this.#child) return this.#child;
    const child = this.#o.fork(join(this.#o.mainDir ?? import.meta.dirname, 'voiceChild.js'));
    child.on('message', (r) => {
      if (this.#child === child && this.#pending && r.id === this.#pending.id) this.#pending.resolve(r);
    });
    child.on('exit', (code) => {
      // A process stopped earlier (idle, or a job that hung) exiting late is no news to the job now running.
      if (this.#child !== child) return;
      this.#child = undefined;
      const pending = this.#pending;
      if (pending) pending.resolve({ id: pending.id, ok: false, error: `The voice process stopped unexpectedly (exit code ${code}).` });
    });
    this.#child = child;
    return child;
  }

  #scheduleIdle(): void {
    clearTimeout(this.#idle);
    this.#idle = setTimeout(() => this.stop(), this.#o.idleMs ?? IDLE_MS);
    this.#idle.unref?.();
  }
}
