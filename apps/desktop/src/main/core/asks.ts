/**
 * Questions an agent asks the user (`ask_user`). An ask is a `kind: 'ask'`
 * Message; its id is the ask id. Agents long-poll for the answer; the first
 * answer (desk, WhatsApp or Clippy) wins, resolves every waiter, marks the
 * message done (decision 27) and emits `ask:answered`.
 */
import type { AnsweredVia, AskResult, Message, NewAskInput } from '@clippy/shared';
import type { Bus } from './bus';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { ConflictError, NotFoundError } from './errors';
import type { Store } from './store';

export interface AsksOptions {
  store: Store;
  bus: Bus;
  clock?: Clock;
}

interface Waiter {
  resolve(result: AskResult): void;
}

export class Asks {
  readonly #store: Store;
  readonly #bus: Bus;
  readonly #clock: Clock;
  readonly #waiters = new Map<string, Set<Waiter>>();

  constructor(options: AsksOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#clock = options.clock ?? systemClock;
  }

  /** Post a question; returns the stored ask Message (emits `message:new`). */
  create(input: NewAskInput): Message {
    return this.#store.createMessage({
      kind: 'ask',
      body: input.question,
      sender: input.sender,
      urgent: input.urgent ?? false,
      ...(input.project !== undefined && { project: input.project }),
      ...(input.options !== undefined && { options: input.options }),
    });
  }

  /** Current result for an ask. Throws NotFoundError if `id` isn't an ask. */
  result(id: string): AskResult {
    return toResult(this.#getAsk(id));
  }

  /**
   * Wait up to `waitMs` for an answer. Resolves immediately if already
   * answered (or `waitMs <= 0`), else on the answer, the timeout (`pending`),
   * or `signal` aborting (`pending`). Throws NotFoundError for an unknown id.
   */
  wait(id: string, waitMs: number, signal?: AbortSignal): Promise<AskResult> {
    const current = this.result(id);
    if (current.status === 'answered' || waitMs <= 0 || signal?.aborted) return Promise.resolve(current);

    return new Promise<AskResult>((resolve) => {
      let set = this.#waiters.get(id);
      if (!set) this.#waiters.set(id, (set = new Set()));
      const waiters = set;
      let timer: TimerHandle | undefined;
      const onAbort = (): void => waiter.resolve({ id, status: 'pending' });
      const waiter: Waiter = {
        resolve: (result) => {
          if (!waiters.delete(waiter)) return; // already settled
          if (waiters.size === 0) this.#waiters.delete(id);
          if (timer !== undefined) this.#clock.clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          resolve(result);
        },
      };
      waiters.add(waiter);
      timer = this.#clock.setTimeout(() => {
        timer = undefined;
        waiter.resolve(this.#currentOrPending(id));
      }, waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /**
   * Answer an ask. Throws NotFoundError for an unknown id and ConflictError if
   * it was already answered.
   */
  answer(id: string, answer: string, via: AnsweredVia): AskResult {
    const ask = this.#getAsk(id);
    if (ask.answer !== undefined) throw new ConflictError(`Ask ${id} was already answered`);
    const message = this.#store.updateMessage(id, {
      answer,
      answeredVia: via,
      state: 'done',
      doneAt: this.#clock.now(),
      snoozedUntil: null,
    })!;
    const result = toResult(message);
    for (const waiter of [...(this.#waiters.get(id) ?? [])]) waiter.resolve(result);
    this.#bus.emit('ask:answered', { message, result });
    return result;
  }

  /** Unanswered asks, newest first. */
  listPending(): Message[] {
    return this.#store.listPendingAsks();
  }

  /** Number of long-polls currently waiting (all asks). */
  get waiterCount(): number {
    let n = 0;
    for (const set of this.#waiters.values()) n += set.size;
    return n;
  }

  /** Release every waiter with its current result (used on shutdown). */
  dispose(): void {
    for (const [id, set] of [...this.#waiters]) {
      for (const waiter of [...set]) waiter.resolve(this.#currentOrPending(id));
    }
  }

  #getAsk(id: string): Message {
    const message = this.#store.getMessage(id);
    if (!message || message.kind !== 'ask') throw new NotFoundError(`No ask ${id}`);
    return message;
  }

  #currentOrPending(id: string): AskResult {
    try {
      return this.result(id);
    } catch {
      return { id, status: 'pending' };
    }
  }
}

function toResult(message: Message): AskResult {
  if (message.answer === undefined) return { id: message.id, status: 'pending' };
  const result: AskResult = { id: message.id, status: 'answered', answer: message.answer };
  if (message.answeredVia !== undefined) result.answeredVia = message.answeredVia;
  return result;
}
