/**
 * Typed in-process event bus for the core service. Main-process integration
 * (IPC push events, WhatsApp relay) subscribes here.
 */
import type { AskResult, Message, Reminder } from '@clippy/shared';

/** Event name → payload. */
export interface CoreEventMap {
  /** A message was stored (note, ask, fired reminder, chat line). */
  'message:new': Message;
  /** A stored message changed (done, snoozed, woke from snooze, answered, waId set, ...). */
  'message:updated': Message;
  /** A reminder fired. `reminder` is its state after firing (advanced or inactive); `message` is the created reminder Message. */
  'reminder:fired': { reminder: Reminder; message: Message };
  /** A reminder was scheduled (for syncing to the WhatsApp relay). */
  'reminder:created': Reminder;
  /** A reminder was cancelled (for syncing to the WhatsApp relay). */
  'reminder:cancelled': Reminder;
  /** An ask was answered. `message` is the updated ask Message. */
  'ask:answered': { message: Message; result: AskResult };
}

export type CoreEvent = keyof CoreEventMap;
type Listener<E extends CoreEvent> = (payload: CoreEventMap[E]) => void;

export class Bus {
  readonly #listeners = new Map<CoreEvent, Set<Listener<never>>>();

  constructor(private readonly onListenerError: (event: CoreEvent, err: unknown) => void = defaultOnError) {}

  /** Subscribe; returns an unsubscribe function. */
  on<E extends CoreEvent>(event: E, listener: Listener<E>): () => void {
    let set = this.#listeners.get(event);
    if (!set) this.#listeners.set(event, (set = new Set()));
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  off<E extends CoreEvent>(event: E, listener: Listener<E>): void {
    this.#listeners.get(event)?.delete(listener as Listener<never>);
  }

  /**
   * Call every listener synchronously. A throwing listener is reported and
   * skipped, so it can't break the operation that emitted the event.
   */
  emit<E extends CoreEvent>(event: E, payload: CoreEventMap[E]): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) {
      try {
        (listener as Listener<E>)(payload);
      } catch (err) {
        this.onListenerError(event, err);
      }
    }
  }
}

function defaultOnError(event: CoreEvent, err: unknown): void {
  console.error(`[clippy] ${event} listener failed:`, err);
}
