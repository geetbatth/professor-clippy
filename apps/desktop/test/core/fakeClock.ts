import type { Clock, TimerHandle } from '../../src/main/core/clock';

interface Timer {
  id: number;
  at: number;
  cb: () => void;
}

/** Manually advanced clock: timers fire in due order as `advance()` passes them. */
export class FakeClock implements Clock {
  #now: number;
  #nextId = 1;
  #timers: Timer[] = [];

  constructor(start: number) {
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  setTimeout(cb: () => void, ms: number): TimerHandle {
    const timer = { id: this.#nextId++, at: this.#now + Math.max(0, ms), cb };
    this.#timers.push(timer);
    return timer.id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers = this.#timers.filter((t) => t.id !== handle);
  }

  /** Number of timers waiting to fire. */
  get pending(): number {
    return this.#timers.length;
  }

  /** Due time of the earliest pending timer. */
  get nextAt(): number | undefined {
    return this.#timers.reduce<number | undefined>((min, t) => (min === undefined || t.at < min ? t.at : min), undefined);
  }

  /** Move time forward by `ms`, firing every timer that comes due (including ones armed meanwhile). */
  advance(ms: number): void {
    this.advanceTo(this.#now + ms);
  }

  advanceTo(target: number): void {
    for (;;) {
      const next = [...this.#timers].sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next || next.at > target) break;
      this.#timers = this.#timers.filter((t) => t !== next);
      this.#now = Math.max(this.#now, next.at);
      next.cb();
    }
    this.#now = Math.max(this.#now, target);
  }

  /** Jump the wall clock without firing timers (simulates the PC being off/asleep). */
  jump(ms: number): void {
    this.#now += ms;
  }
}
