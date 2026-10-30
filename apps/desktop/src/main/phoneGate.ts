/**
 * Decides when a message goes to the phone. Nothing mirrors to WhatsApp or Telegram on
 * `message:new` any more; the relay and Telegram wait for this gate's `message:mirror`.
 *
 * - User away (or the setting says "always"): a new note, ask or fired reminder is mirrored at once.
 * - User at the PC: it is held. A slow tick (`tickMs`) re-reads each held message from the
 *   store; once the user is away, the ones still unread are mirrored, once. A held message
 *   dismissed (state done) or answered meanwhile is dropped, never sent. A snoozed one stays held
 *   until it wakes.
 * - Going away does not flush a pile of stale news: a note or reminder that has been waiting more
 *   than {@link FLUSH_MAX_AGE_MS} is dropped from the hold instead (it stays on the desk).
 * - A held ask still unanswered after `askEscalateMs()` of waiting is mirrored on the next tick even
 *   while the user is at the PC (a question left sitting should reach them). Notes and reminders are not.
 * - "Waiting" is counted from when the message was held, and starts again when it wakes from a
 *   snooze, so a snoozed ask is not sent the moment it comes back.
 * - Messages that arrive `done` (quiet agent-finished notes, chat lines) are never mirrored.
 *
 * Electron-free: "away" is injected (`startServices` builds it from the idle time and the
 * away threshold).
 */
import type { Message } from '@clippy/shared';
import type { Bus } from './core/bus';
import { systemClock, type Clock, type TimerHandle } from './core/clock';
import type { Store } from './core/store';

export interface PhoneGateOptions {
  bus: Bus;
  store: Store;
  isUserAway: () => boolean;
  /** Read live from settings (`phoneWhen`). */
  mode: () => 'away' | 'always';
  clock?: Clock;
  /** How often held messages are checked once the user may have left. Default 30 s. */
  tickMs?: number;
  /**
   * How long a held ask waits before it goes to the phone even at the PC. Read each tick, so a
   * settings change applies. Default 5 min.
   */
  askEscalateMs?: () => number;
  /** Where a failed tick is reported (once). Default `console.warn`. */
  log?: (message: string, err?: unknown) => void;
}

const DEFAULT_TICK_MS = 30_000;
const DEFAULT_ASK_ESCALATE_MS = 5 * 60_000;
/** A held note or reminder older than this is not mirrored when the user goes away. */
export const FLUSH_MAX_AGE_MS = 60 * 60_000;

interface Held {
  /** When the message started waiting: when it was held, or when it last woke from a snooze. */
  since: number;
  snoozed: boolean;
}

export class PhoneGate {
  readonly #o: PhoneGateOptions;
  readonly #clock: Clock;
  readonly #held = new Map<string, Held>();
  #unsubscribe: (() => void)[] = [];
  #timer: TimerHandle | undefined;
  #running = false;
  #warned = false;

  constructor(options: PhoneGateOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  /** Ids waiting for the user to go away (oldest first). */
  get heldIds(): string[] {
    return [...this.#held.keys()];
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe.push(
      this.#o.bus.on('message:new', (m) => this.#onNew(m)),
      this.#o.bus.on('message:updated', (m) => this.#onUpdated(m)),
    );
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    for (const off of this.#unsubscribe.splice(0)) off();
    if (this.#timer !== undefined) this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#held.clear();
  }

  #open(): boolean {
    return this.#o.mode() === 'always' || this.#o.isUserAway();
  }

  #onNew(m: Message): void {
    if (m.kind !== 'note' && m.kind !== 'ask' && m.kind !== 'reminder') return;
    if (m.state === 'done') return;
    if (m.state === 'unread' && this.#open()) this.#o.bus.emit('message:mirror', m);
    else this.#held.set(m.id, { since: this.#clock.now(), snoozed: m.state === 'snoozed' });
  }

  #onUpdated(m: Message): void {
    const held = this.#held.get(m.id);
    if (!held) return;
    if (m.state === 'done') this.#held.delete(m.id);
    else if (m.state === 'snoozed') held.snoozed = true;
    else if (m.state === 'unread' && held.snoozed) {
      // Woke from a snooze: it starts waiting afresh.
      held.snoozed = false;
      held.since = this.#clock.now();
    }
  }

  /** Never throws: it runs from a timer, where an exception would be unhandled. */
  #tick(): void {
    try {
      const open = this.#open();
      const now = this.#clock.now();
      const escalateMs = (this.#o.askEscalateMs ?? (() => DEFAULT_ASK_ESCALATE_MS))();
      for (const [id, held] of [...this.#held]) {
        const m = this.#o.store.getMessage(id);
        if (!m || m.state === 'done') {
          this.#held.delete(id); // gone, dismissed or answered meanwhile
          continue;
        }
        if (m.state !== 'unread') continue; // snoozed: stays held until it wakes
        const age = now - held.since;
        const escalate = m.kind === 'ask' && age >= escalateMs;
        if (open && m.kind !== 'ask' && age > FLUSH_MAX_AGE_MS) {
          this.#held.delete(id); // stale news is not worth a phone buzz; it stays on the desk
        } else if (open || escalate) {
          this.#held.delete(id);
          this.#o.bus.emit('message:mirror', m);
        }
      }
    } catch (err) {
      // E.g. the store was closed under us. Say so once; keep ticking only while still running.
      if (!this.#warned) {
        this.#warned = true;
        (this.#o.log ?? console.warn)('[clippy] phone gate tick failed:', err);
      }
    }
    this.#arm(); // a no-op once stopped
  }

  #arm(): void {
    if (!this.#running) return;
    this.#timer = this.#clock.setTimeout(() => this.#tick(), this.#o.tickMs ?? DEFAULT_TICK_MS);
  }
}
