/**
 * The morning brief: once a day (default 09:00, weekdays) Clippy leaves one note from himself with
 * today's reminders, what is waiting on the user, the unread count and what the agents did
 * overnight. It is an ordinary `sender: 'clippy'` note, so it is loud on the desk and goes to the
 * phone by the phone gate when the user is away.
 *
 * `composeBrief` is pure. `BriefScheduler` keeps one timer (capped at an hour like the reminder
 * scheduler's, then re-armed, so a long wait and clock changes are handled). The day's brief is
 * recorded in kv (`briefLastDate`, local `YYYY-MM-DD`), so a restart or a wake from sleep never
 * sends a second one. A PC that was off at brief time still gets it when it comes back, if that is
 * before {@link CATCH_UP_BEFORE_HOUR} (noon) or within {@link CATCH_UP_MS} of the brief time (so a
 * late brief time still works); after that the day is skipped.
 *
 * Electron-free; `stop()` disarms the timer so nothing can fire after the store closes.
 */
import { BRAIN_SENDER, type Message, type Reminder, type Settings } from '@clippy/shared';
import { systemClock, type Clock, type TimerHandle } from './core/clock';
import { ERROR_BACKOFF_MS, MAX_ARM_MS } from './core/scheduler';
import type { Store } from './core/store';

export const BRIEF_TITLE = '☀️ Morning brief';
/** Sender of Clippy's own generated notes. */
const BRIEF_SENDER = 'clippy';
/** A brief missed (PC asleep or app closed) is still sent this long after its time... */
export const CATCH_UP_MS = 2 * 60 * 60 * 1000;
/** ...or at any time before this local hour, whichever is later; after both the day is skipped. */
export const CATCH_UP_BEFORE_HOUR = 12;
/** Overnight activity reaches this far back when there was no earlier brief. */
export const DEFAULT_LOOKBACK_MS = 16 * 60 * 60 * 1000;
/** Most waiting questions named in the brief. */
const MAX_ASKS_LISTED = 3;
const ASK_LABEL_MAX = 40;

const KV_DATE = 'briefLastDate';
const KV_AT = 'briefLastAt';

export interface BriefInput {
  now: number;
  reminders: Reminder[];
  pendingAsks: Message[];
  unread: Message[];
  /** Messages since the last brief; chat and Clippy's own notes are left out here. */
  activity: Message[];
}

const pad = (n: number): string => String(n).padStart(2, '0');
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
/** Local `YYYY-MM-DD`. */
export const localDate = (t: number): string => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Clippy's own notes (the brief, nudges, the brain's) are never news to him. */
const isClippysOwn = (m: Message): boolean => m.sender === BRIEF_SENDER || m.sender === BRAIN_SENDER;

/** First line of an ask, cut short, as its label. */
function askLabel(m: Message): string {
  const line = m.body.split('\n', 1)[0]!.trim();
  return line.length > ASK_LABEL_MAX ? `${line.slice(0, ASK_LABEL_MAX - 1)}…` : line;
}

/** "agent finished 3×, 1 note, 2 questions" for one project's overnight messages. */
function describeActivity(messages: Message[]): string {
  const finished = messages.filter((m) => m.event === 'agent-finished').length;
  const questions = messages.filter((m) => m.event !== 'agent-finished' && m.kind === 'ask').length;
  const notes = messages.length - finished - questions;
  const parts: string[] = [];
  if (finished > 0) parts.push(`agent finished ${finished}×`);
  if (notes > 0) parts.push(plural(notes, 'note'));
  if (questions > 0) parts.push(plural(questions, 'question'));
  return parts.join(', ');
}

/** Overnight activity lines, one per project (agents' notes and questions only), busiest first. */
function activityLines(activity: Message[]): string[] {
  const byProject = new Map<string, Message[]>();
  for (const m of activity) {
    if (m.kind !== 'note' && m.kind !== 'ask') continue;
    if (isClippysOwn(m)) continue;
    const project = m.project ?? 'other';
    byProject.set(project, [...(byProject.get(project) ?? []), m]);
  }
  return [...byProject]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([project, messages]) => `• ${project}: ${describeActivity(messages)}`);
}

/** Active reminders due by the end of `now`'s local day, soonest first, as `• HH:MM body`. */
function reminderLines(now: number, reminders: Reminder[]): string[] {
  const d = new Date(now);
  const nextMidnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  return reminders
    .filter((r) => r.active && r.dueAt < nextMidnight)
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((r) => {
      const due = new Date(r.dueAt);
      return `• ${pad(due.getHours())}:${pad(due.getMinutes())} ${r.body}`;
    });
}

/** The brief's title and body. With nothing to report the body is a single "clear day" line. */
export function composeBrief(i: BriefInput): { title: string; body: string } {
  const reminders = reminderLines(i.now, i.reminders);
  const asks = i.pendingAsks;
  // Unanswered questions have their own line; the rest of the unread pile is counted once.
  const unread = i.unread.filter((m) => m.kind !== 'ask' && m.kind !== 'chat' && !isClippysOwn(m)).length;
  const activity = activityLines(i.activity);
  if (reminders.length === 0 && asks.length === 0 && unread === 0 && activity.length === 0) {
    return { title: BRIEF_TITLE, body: 'Clear day: no reminders, nothing waiting on you.' };
  }
  const lines: string[] = reminders.length > 0 ? ['Today:', ...reminders] : ['No reminders today.'];
  if (asks.length > 0) {
    const shown = asks.slice(0, MAX_ASKS_LISTED).map(askLabel).join(', ');
    const more = asks.length > MAX_ASKS_LISTED ? `, and ${asks.length - MAX_ASKS_LISTED} more` : '';
    lines.push(`Waiting on you: ${plural(asks.length, 'question')} (${shown}${more})`);
  }
  if (unread > 0) lines.push(`Unread: ${plural(unread, 'note')}`);
  if (activity.length > 0) lines.push('Overnight:', ...activity);
  return { title: BRIEF_TITLE, body: lines.join('\n') };
}

type BriefSettings = Pick<Settings, 'briefEnabled' | 'briefTime' | 'briefWeekdaysOnly'>;

export interface BriefSchedulerOptions {
  store: Store;
  clock?: Clock;
  /** Read fresh each time, so a settings change takes effect on the next `reschedule()`. */
  settings: () => BriefSettings;
}

export class BriefScheduler {
  readonly #store: Store;
  readonly #clock: Clock;
  readonly #settings: () => BriefSettings;
  #timer: TimerHandle | undefined;
  #running = false;

  constructor(options: BriefSchedulerOptions) {
    this.#store = options.store;
    this.#clock = options.clock ?? systemClock;
    this.#settings = options.settings;
  }

  /** Send today's brief if it is due (or a little late), then arm the timer. */
  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#run();
  }

  stop(): void {
    this.#running = false;
    this.#disarm();
  }

  /** After the PC wakes: the timer may have been missed, so check again. */
  onResume(): void {
    if (this.#running) this.#run();
  }

  /** The brief settings changed: arm the timer for the new time (nothing is sent on the spot). */
  reschedule(): void {
    if (!this.#running) return;
    try {
      this.#arm();
    } catch (err) {
      console.error('[clippy] brief re-arm failed:', err);
    }
  }

  #run(): void {
    let failed = false;
    try {
      this.#sendIfDue();
    } catch (err) {
      failed = true;
      console.error('[clippy] morning brief failed:', err);
    }
    try {
      // After a failure retry shortly (still inside the catch-up window), not in a busy loop.
      this.#arm(failed ? ERROR_BACKOFF_MS : undefined);
    } catch (err) {
      console.error('[clippy] brief re-arm failed:', err);
    }
  }

  #sendIfDue(): void {
    const now = this.#clock.now();
    const s = this.#settings();
    if (!s.briefEnabled || !this.#isBriefDay(now, s)) return;
    if (this.#store.getKv(KV_DATE) === localDate(now)) return;
    const late = now - this.#briefTime(now, s);
    const today = new Date(now);
    const noon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), CATCH_UP_BEFORE_HOUR).getTime();
    // Not due yet, or missed by more than the grace and past noon: nothing until the next brief day.
    if (late < 0 || (late > CATCH_UP_MS && now >= noon)) return;
    const since = Number(this.#store.getKv(KV_AT)) || now - DEFAULT_LOOKBACK_MS;
    // Note and bookkeeping commit together: a failure can't leave a sent brief unrecorded (and sent twice).
    this.#store.transaction(() => {
      const { title, body } = composeBrief({
        now,
        reminders: this.#store.listActiveReminders(),
        pendingAsks: this.#store.listPendingAsks(),
        unread: this.#store.listMessages({ state: 'unread' }),
        activity: this.#store.listMessagesSince(since),
      });
      this.#store.createMessage({ kind: 'note', sender: BRIEF_SENDER, title, body });
      this.#store.setKv(KV_DATE, localDate(now));
      this.#store.setKv(KV_AT, String(now));
    });
  }

  /** Whether `t`'s day gets a brief at all (weekends are skipped with `briefWeekdaysOnly`). */
  #isBriefDay(t: number, s: BriefSettings): boolean {
    const day = new Date(t).getDay();
    return !s.briefWeekdaysOnly || (day !== 0 && day !== 6);
  }

  /** Brief time on the local day of `t`. */
  #briefTime(t: number, s: BriefSettings): number {
    const [h, m] = s.briefTime.split(':').map(Number) as [number, number];
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime();
  }

  /** The next moment a brief is due, or undefined when they are off. */
  #nextDue(now: number, s: BriefSettings): number | undefined {
    if (!s.briefEnabled) return undefined;
    const sentToday = this.#store.getKv(KV_DATE) === localDate(now);
    // A week ahead always holds a weekday.
    for (let ahead = 0; ahead <= 7; ahead++) {
      const day = new Date(now);
      day.setDate(day.getDate() + ahead);
      const at = this.#briefTime(day.getTime(), s);
      if (!this.#isBriefDay(day.getTime(), s) || at <= now || (ahead === 0 && sentToday)) continue;
      return at;
    }
    return undefined;
  }

  /** Arm the single timer for the next brief (never longer than an hour), or `retryIn` ms if given. */
  #arm(retryIn?: number): void {
    this.#disarm();
    if (!this.#running) return;
    const now = this.#clock.now();
    const due = retryIn !== undefined ? now + retryIn : this.#nextDue(now, this.#settings());
    if (due === undefined) return;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#run();
    }, Math.min(due - now, MAX_ARM_MS));
  }

  #disarm(): void {
    if (this.#timer === undefined) return;
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
