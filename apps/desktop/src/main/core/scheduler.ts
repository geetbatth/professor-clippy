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
 * - Each reminder fires in its own transaction; after any failure the timer
 *   backs off ERROR_BACKOFF_MS instead of retrying in a busy loop.
 */
import type { Message, NewReminderInput, Reminder } from '@clippy/shared';
import type { Bus } from './bus';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { NotFoundError, ValidationError } from './errors';
import { nextOccurrence, normalizeRrule } from './recurrence';
import type { ScheduledReminder, Store } from './store';

/** Longest single timer; re-armed after this so long waits and clock changes are handled. */
export const MAX_ARM_MS = 60 * 60 * 1000;
/** Default lateness after which a timer-fired reminder counts as missed. */
export const DEFAULT_MISSED_GRACE_MS = 60 * 1000;
/** After a failed tick, wait this long before retrying (instead of a busy loop). */
export const ERROR_BACKOFF_MS = 30 * 1000;

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

  /**
   * Reconcile a firing done by the relay Worker (which already sent it to WhatsApp, so
   * nothing here ever sends anything). Idempotent: applying the same firing twice changes
   * nothing the second time.
   *
   * - If the desktop has not shown that occurrence yet (the reminder is active and its
   *   `dueAt` is at or before `firedAt`), the reminder Message is created now, carrying the
   *   Worker's `waId`, and the reminder advances (emits `message:new` + `reminder:fired`).
   * - Otherwise the desktop already showed it: the Worker's `waId` is attached to the
   *   reminder's latest message if that has none yet.
   * - Schedule: `nextDueAt` absent means the Worker finished the reminder, so the desktop
   *   copy is deactivated; a future `nextDueAt` becomes the desktop `dueAt`. A past one
   *   belongs to a stale (redelivered or caught-up) firing and is ignored.
   */
  applyRemoteFiring(firing: { reminderId: string; firedAt: number; waId?: string; nextDueAt?: number }): {
    reminder?: Reminder;
    message?: Message;
  } {
    const r = this.#store.getScheduledReminder(firing.reminderId);
    if (!r) return {};
    const now = this.#clock.now();
    const futureNext = firing.nextDueAt !== undefined && firing.nextDueAt > now ? firing.nextDueAt : undefined;
    try {
      if (r.active && r.dueAt <= firing.firedAt) {
        const fired = this.#store.transaction(() => {
          const message = this.#store.createMessage({
            kind: 'reminder',
            body: r.body,
            sender: r.sender,
            reminderId: r.id,
            ...(r.project !== undefined && { project: r.project }),
            ...(firing.waId !== undefined && { waId: firing.waId }),
            ...(now - r.dueAt > this.#missedGraceMs && { missed: true }),
          });
          // Recurring: the Worker's next occurrence, or (if that is already past) our own next one after now.
          const next =
            firing.nextDueAt === undefined || r.rrule === undefined
              ? undefined
              : (futureNext ?? nextOccurrence(r.rrule, r.startAt, now));
          const reminder = this.#store.updateReminder(r.id, {
            lastFiredAt: now,
            ...(next === undefined ? { active: false } : { dueAt: next }),
          })!;
          return { reminder, message };
        });
        this.#bus.emit('reminder:fired', fired);
        return fired;
      }

      let message: Message | undefined;
      if (firing.waId !== undefined) {
        const latest = this.#store.findLatestReminderMessage(r.id);
        message = latest?.waId === undefined && latest ? this.#store.updateMessage(latest.id, { waId: firing.waId }) : latest;
      }
      let reminder: Reminder = r;
      if (r.active && firing.nextDueAt === undefined) reminder = this.#store.updateReminder(r.id, { active: false })!;
      else if (r.active && futureNext !== undefined && futureNext !== r.dueAt) {
        reminder = this.#store.updateReminder(r.id, { dueAt: futureNext })!;
      }
      return { reminder: stripAnchor(reminder), ...(message && { message }) };
    } finally {
      try {
        this.#arm();
      } catch (err) {
        console.error('[clippy] scheduler re-arm failed:', err);
      }
    }
  }

  #run(catchUp: boolean): void {
    let failed = this.#fireDue(catchUp);
    try {
      this.#wakeSnoozed();
    } catch (err) {
      failed = true;
      console.error('[clippy] waking snoozed messages failed:', err);
    }
    try {
      // After a failure the failing item is still due: retry later, not in a busy loop.
      this.#arm(failed ? ERROR_BACKOFF_MS : 0);
    } catch (err) {
      console.error('[clippy] scheduler re-arm failed:', err);
    }
  }

  /** Fire every due reminder; one failing reminder doesn't stop the others. Returns true if any failed. */
  #fireDue(catchUp: boolean): boolean {
    let failed = false;
    let due: ScheduledReminder[];
    const now = this.#clock.now();
    try {
      due = this.#store.listDueReminders(now);
    } catch (err) {
      console.error('[clippy] listing due reminders failed:', err);
      return true;
    }
    for (const r of due) {
      try {
        // Message + reminder update commit together (events are emitted after commit),
        // so a failure can't leave a fired message without the reminder advancing.
        const fired = this.#store.transaction(() => {
          const missed = catchUp || now - r.dueAt > this.#missedGraceMs;
          const message = this.#store.createMessage({
            kind: 'reminder',
            body: r.body,
            sender: r.sender,
            reminderId: r.id,
            ...(r.project !== undefined && { project: r.project }),
            ...(missed && { missed: true }),
          });
          // nextOccurrence guarantees next > now, so a reminder can't stay due and loop.
          const next = r.rrule === undefined ? undefined : nextOccurrence(r.rrule, r.startAt, now);
          const reminder = this.#store.updateReminder(r.id, {
            lastFiredAt: now,
            ...(next === undefined ? { active: false } : { dueAt: next }),
          })!;
          return { reminder, message };
        });
        this.#bus.emit('reminder:fired', fired);
      } catch (err) {
        failed = true;
        console.error(`[clippy] firing reminder ${r.id} failed:`, err);
      }
    }
    return failed;
  }

  #wakeSnoozed(): void {
    for (const m of this.#store.listExpiredSnoozes(this.#clock.now())) {
      this.#store.updateMessage(m.id, { state: 'unread', snoozedUntil: null });
    }
  }

  /** Arm the single timer for the next due item, but not sooner than `minDelay` ms. */
  #arm(minDelay = 0): void {
    this.#disarm();
    if (!this.#running) return;
    const candidates = [this.#store.nextReminderDue(), this.#store.nextSnoozeWake()].filter(
      (t): t is number => t !== undefined,
    );
    if (candidates.length === 0) return;
    const delay = Math.min(Math.max(minDelay, Math.min(...candidates) - this.#clock.now()), MAX_ARM_MS);
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

/** A plain Reminder (without the internal `startAt` anchor). */
function stripAnchor(r: Reminder | ScheduledReminder): Reminder {
  if (!('startAt' in r)) return r;
  const { startAt: _startAt, ...rest } = r;
  return rest;
}
