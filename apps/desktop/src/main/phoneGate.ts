/**
 * Decides when a message goes to the phone. Nothing mirrors to WhatsApp or Telegram on
 * `message:new` any more; the relay and Telegram wait for this gate's `message:mirror`.
 *
 * - User away (or the setting says "always"): a new note, ask or fired reminder is mirrored at once.
 * - User at the PC: it is held. A slow tick (`tickMs`) re-reads each held message from the
 *   store; once the user is away, the ones still unread (asks: still unanswered) are mirrored,
 *   once. A held message dismissed or answered meanwhile is dropped, never sent. A snoozed one
 *   stays held until it wakes.
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
}

const DEFAULT_TICK_MS = 30_000;

export class PhoneGate {
  readonly #o: PhoneGateOptions;
  readonly #clock: Clock;
  readonly #held = new Set<string>();
  #unsubscribe: (() => void)[] = [];
  #timer: TimerHandle | undefined;
  #running = false;

  constructor(options: PhoneGateOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  /** Ids waiting for the user to go away (oldest first). */
  get heldIds(): string[] {
    return [...this.#held];
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#unsubscribe.push(
      this.#o.bus.on('message:new', (m) => this.#onNew(m)),
      this.#o.bus.on('message:updated', (m) => {
        if (!isPending(m)) this.#held.delete(m.id);
      }),
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
    else this.#held.add(m.id);
  }

  #tick(): void {
    if (this.#held.size > 0 && this.#open()) {
      for (const id of [...this.#held]) {
        const m = this.#o.store.getMessage(id);
        if (!m || !isPending(m)) this.#held.delete(id); // gone, dismissed or answered meanwhile
        else if (m.state !== 'snoozed') {
          this.#held.delete(id);
          this.#o.bus.emit('message:mirror', m);
        } // snoozed: stays held until it wakes
      }
    }
    this.#arm();
  }

  #arm(): void {
    if (!this.#running) return;
    this.#timer = this.#clock.setTimeout(() => this.#tick(), this.#o.tickMs ?? DEFAULT_TICK_MS);
  }
}

/** Still worth sending: not dealt with (an ask: not answered; the relay's own rule). Snoozed counts as pending. */
function isPending(m: Message): boolean {
  return m.kind === 'ask' ? m.answer === undefined : m.state !== 'done';
}
