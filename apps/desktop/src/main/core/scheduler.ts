/**
 * Reminder scheduler. One timer, armed for the earliest of: the next active
 * reminder's due time, or the next snoozed message's wake-up time.
 *
 * - Firing a reminder stores a `kind: 'reminder'` Message (emitting
 *   `message:new`) and then emits `reminder:fired`. One-off reminders become
 *   inactive; recurring ones advance to their next occurrence after now.
 * - Catch-up (`start()`, `onResume()`): every reminder that came due while the
 *   app was stopped/asleep fires **once** with `missed: true`, however many
 *   recurrences were skipped, then advances to the next future occurrence.
 * - A timer that fires more than `missedGraceMs` late (e.g. the PC slept and the
 *   timer ran before the resume event) also marks the message missed.
 * - Expired snoozes return to `unread` (emitting `message:updated`).
 */
import type { NewReminderInput, Reminder } from '@clippy/shared';
import type { Bus } from './bus';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { NotFoundError, ValidationError } from './errors';
import { nextOccurrence, normalizeRrule } from './recurrence';
import type { ScheduledReminder, Store } from './store';

/** Longest single timer; re-armed after this so long waits and clock changes are handled. */
export const MAX_ARM_MS = 60 * 60 * 1000;
/** Default lateness after which a timer-fired reminder counts as missed. */
export const DEFAULT_MISSED_GRACE_MS = 60 * 1000;

export interface SchedulerOptions {
  store: Store;
  bus: Bus;
  clock?: Clock;
  missedGraceMs?: number;
}

export class Scheduler {
  readonly #store: Store;
  readonly #bus: Bus;
  readonly #clock: Clock;
  readonly #missedGraceMs: number;
  #timer: TimerHandle | undefined;
  #running = false;
  #unsubscribe: (() => void) | undefined;

  constructor(options: SchedulerOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#clock = options.clock ?? systemClock;
    this.#missedGraceMs = options.missedGraceMs ?? DEFAULT_MISSED_GRACE_MS;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Catch up on anything that came due while stopped, then arm the timer. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    // Re-arm when a message is snoozed from anywhere (API, IPC).
    this.#unsubscribe = this.#bus.on('message:updated', (m) => {
      if (m.state === 'snoozed') this.#arm();
    });
    this.#run(true);
  }

  stop(): void {
    this.#running = false;
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#disarm();
  }

  /** Call after the PC wakes from sleep: catch up (missed) and re-arm. */
  onResume(): void {
    if (this.#running) this.#run(true);
  }

  /**
   * Schedule a reminder. `when` without an offset is local time. A one-off
   * reminder whose `when` has passed fires immediately. A recurring reminder's
   * first due time is its first occurrence at/after max(when, now).
   */
  create(input: NewReminderInput): Reminder {
    const startAt = Date.parse(input.when);
    if (Number.isNaN(startAt)) throw new ValidationError(`Invalid when: ${input.when}`);
    const now = this.#clock.now();
    let dueAt = Math.max(startAt, now);
    let rrule: string | undefined;
    if (input.rrule !== undefined) {
      rrule = normalizeRrule(input.rrule);
      const first = nextOccurrence(rrule, startAt, dueAt, true);
      if (first === undefined) throw new ValidationError('rrule has no occurrences in the future');
      dueAt = first;
    }
    const reminder: ScheduledReminder = {
      id: this.#store.newId(),
      body: input.body,
      sender: input.sender,
      dueAt,
      active: true,
      createdAt: now,
      startAt,
    };
    if (input.project !== undefined) reminder.project = input.project;
    if (rrule !== undefined) reminder.rrule = rrule;
    this.#store.insertReminder(reminder);
    const created = this.#store.getReminder(reminder.id)!;
    this.#bus.emit('reminder:created', created);
    this.#arm();
    return created;
  }

  /** Cancel (deactivate) a reminder. Throws NotFoundError for an unknown id; cancelling twice is a no-op. */
  cancel(id: string): Reminder {
    const existing = this.#store.getReminder(id);
    if (!existing) throw new NotFoundError(`No reminder ${id}`);
    if (!existing.active) return existing;
    const cancelled = this.#store.updateReminder(id, { active: false })!;
    this.#bus.emit('reminder:cancelled', cancelled);
    this.#arm();
    return cancelled;
  }

  /** Active reminders, soonest first. */
  list(): Reminder[] {
    return this.#store.listActiveReminders();
  }

  #run(catchUp: boolean): void {
    try {
      this.#fireDue(catchUp);
      this.#wakeSnoozed();
    } catch (err) {
      console.error('[clippy] scheduler tick failed:', err);
    }
    this.#arm();
  }

  #fireDue(catchUp: boolean): void {
    const now = this.#clock.now();
    for (const due of this.#store.listDueReminders(now)) {
      const missed = catchUp || now - due.dueAt > this.#missedGraceMs;
      const message = this.#store.createMessage({
        kind: 'reminder',
        body: due.body,
        sender: due.sender,
        ...(due.project !== undefined && { project: due.project }),
        ...(missed && { missed: true }),
      });
      const next = due.rrule === undefined ? undefined : nextOccurrence(due.rrule, due.startAt, now);
      const reminder = this.#store.updateReminder(due.id, {
        lastFiredAt: now,
        ...(next === undefined ? { active: false } : { dueAt: next }),
      })!;
      this.#bus.emit('reminder:fired', { reminder, message });
    }
  }

  #wakeSnoozed(): void {
    for (const m of this.#store.listExpiredSnoozes(this.#clock.now())) {
      this.#store.updateMessage(m.id, { state: 'unread', snoozedUntil: null });
    }
  }

  #arm(): void {
    this.#disarm();
    if (!this.#running) return;
    const candidates = [this.#store.nextReminderDue(), this.#store.nextSnoozeWake()].filter(
      (t): t is number => t !== undefined,
    );
    if (candidates.length === 0) return;
    const delay = Math.min(Math.max(0, Math.min(...candidates) - this.#clock.now()), MAX_ARM_MS);
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#run(false);
    }, delay);
  }

  #disarm(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
