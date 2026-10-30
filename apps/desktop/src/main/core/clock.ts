/**
 * Injectable time source for the core service. Production uses {@link systemClock};
 * tests pass a fake clock so scheduler and long-poll behaviour is deterministic.
 */

/** Opaque handle returned by {@link Clock.setTimeout}. */
export type TimerHandle = unknown;

export interface Clock {
  /** Current time, epoch ms. */
  now(): number;
  /** Run `cb` once after `ms` milliseconds. */
  setTimeout(cb: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Node's setTimeout overflows (fires immediately) above this many ms. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Real wall clock. Timers are unref'd so they never keep a process alive on their own. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout(cb, ms) {
    const timer = setTimeout(cb, Math.min(Math.max(0, ms), MAX_TIMEOUT_MS));
    timer.unref();
    return timer;
  },
  clearTimeout(handle) {
    clearTimeout(handle as NodeJS.Timeout);
  },
};
