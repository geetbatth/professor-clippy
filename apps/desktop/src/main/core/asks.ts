/**
 * Questions an agent asks the user (`ask_user`). An ask is a `kind: 'ask'`
 * Message; its id is the ask id. Agents long-poll for the answer; the first
 * answer (desk, WhatsApp or Clippy) wins, resolves every waiter, marks the
 * message done (decision 27) and emits `ask:answered`.
 */
import type { AgentEvent, AnsweredVia, AskResult, Message, NewAskInput } from '@clippy/shared';
import type { Bus } from './bus';
import { systemClock, type Clock, type TimerHandle } from './clock';
import { ConflictError, NotFoundError } from './errors';
import type { Store } from './store';

export interface AsksOptions {
  store: Store;
  bus: Bus;
  clock?: Clock;
}

/**
 * Checks an answer before it is stored; throws (e.g. a `ForbiddenError`) to refuse it. Power
 * actions and phone approvals use one so Clippy's brain (`via: 'clippy'`) can never confirm a
 * restart or approve an agent's permission request.
 */
export type AnswerGuard = (ask: Message, via: AnsweredVia) => void;

interface Waiter {
  resolve(result: AskResult): void;
}

export class Asks {
  readonly #store: Store;
  readonly #bus: Bus;
  readonly #clock: Clock;
  readonly #waiters = new Map<string, Set<Waiter>>();
  readonly #guards = new Set<AnswerGuard>();

  constructor(options: AsksOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#clock = options.clock ?? systemClock;
  }

  /**
   * Post a question; returns the stored ask Message (emits `message:new`). With `auto`, a standing
   * order has already answered it: it is stored answered (`answeredVia: 'clippy'`) and done, so it
   * never pops up or goes to the phone, and an agent waiting on it gets the answer at once.
   * `event` is for asks the app makes itself (phone approvals); `POST /asks` bodies never carry one.
   */
  create(input: NewAskInput & { event?: AgentEvent }, auto?: { orderId: string; answer: string }): Message {
    return this.#store.createMessage({
      kind: 'ask',
      body: input.question,
      sender: input.sender,
      urgent: input.urgent ?? false,
      ...(input.project !== undefined && { project: input.project }),
      ...(input.options !== undefined && { options: input.options }),
      ...(input.event !== undefined && { event: input.event }),
      ...(auto && { state: 'done' as const, answer: auto.answer, answeredVia: 'clippy' as const, orderId: auto.orderId }),
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

  /** Add a check every answer must pass (see {@link AnswerGuard}); returns its remover. */
  guard(check: AnswerGuard): () => void {
    this.#guards.add(check);
    return () => this.#guards.delete(check);
  }

  /**
   * Answer an ask. Throws NotFoundError for an unknown id, ConflictError if
   * it was already answered, and whatever a guard throws to refuse it.
   */
  answer(id: string, answer: string, via: AnsweredVia): AskResult {
    const ask = this.#getAsk(id);
    if (ask.answer !== undefined) throw new ConflictError(`Ask ${id} was already answered`);
    for (const check of this.#guards) check(ask, via);
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
