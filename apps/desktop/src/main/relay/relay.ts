/**
 * WhatsApp relay logic: what the desktop sends to the Worker, and what it does with what
 * the Worker sends back. Transport details live in `relayClient.ts`.
 *
 * Outbound (controller rulings):
 * - Every new `note` and `ask` Message is mirrored with `POST /send`; the returned `waId`
 *   is stored on the Message (that is how quote-replies find their ask).
 * - Reminder Messages are never sent by the desktop: the Worker fires synced reminders
 *   itself and owns their WhatsApp delivery.
 * - A reminder is synced when it is created (`PUT /reminders/:id`, always with the PC's
 *   IANA `tz`) and deleted when it is cancelled. Nothing is re-synced on reconnect.
 * - Gap-fill, {@link Relay.syncExistingReminders}: run by `RelayManager` each time it starts a
 *   relay (app start, or a changed Worker URL or secret; never on a socket reconnect). It
 *   PUTs every active future reminder the Worker has not acknowledged yet. The ids a Worker
 *   holds are tracked per Worker URL in kv, and an id goes in only after a 2xx PUT, so a
 *   rejected secret, exhausted retries or a quit mid-way are filled in next time. A reminder
 *   the Worker acknowledged is not PUT again by the gap-fill, but the same PUT can still reach
 *   the Worker twice (a retry after a lost response or a timeout); that is harmless, because a
 *   PUT is idempotent on the Worker (it replaces the row).
 * - Withdrawal, {@link Relay.withdrawReminders}: when WhatsApp is disconnected or moved to
 *   another Worker, `RelayManager` DELETEs every reminder the old Worker holds (best effort,
 *   time-boxed). Ids whose DELETE fails stay recorded, so reconnecting to that Worker later
 *   lets the gap-fill finish the job.
 * - Chat replies to WhatsApp messages are sent with kind `chat`. Desk chat isn't mirrored.
 * - Failed calls are retried with backoff (5 s → 10 min, 5 attempts) unless the Worker
 *   answered with a permanent 4xx, and only while still relevant.
 *
 * Inbound frames (idempotent; the Worker redelivers anything unacked):
 * - `inbound` quote-replying to an unanswered ask's `waId` answers that ask
 *   (`answeredVia: 'whatsapp'`). Any other text is stored as a user chat line and becomes a
 *   brain turn, whose reply goes back with `/send`.
 * - `reminder-fired` is reconciled through `scheduler.applyRemoteFiring` (it never sends).
 */
import type { Message, Reminder, RelayInbound, RelayReminderFired, WorkerToPc } from '@clippy/shared';
import type { Bus } from '../core/bus';
import { ConflictError } from '../core/errors';
import type { Asks } from '../core/asks';
import type { Scheduler } from '../core/scheduler';
import type { Store } from '../core/store';
import type { BrainReply, Channel } from '../brain/brain';
import { RelayHttpError, type RelayTransport } from './relayClient';

/** Delays before each retry of a failed Worker call. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 2 * 60_000, 10 * 60_000] as const;
/** kv key: recently handled inbound frame ids (dedupe across redeliveries and restarts). */
export const SEEN_KV_KEY = 'relaySeenInbound';
const SEEN_KEEP = 500;
/** Total time a withdrawal (disconnect, or a move to another Worker) may take. */
export const WITHDRAW_TIMEOUT_MS = 10_000;
/** kv key prefix: ids of the reminders a Worker holds (`relaySyncedReminders:<worker URL>`). */
export const SYNCED_KV_PREFIX = 'relaySyncedReminders:';

/** One spelling per Worker: no trailing slash, lower-case scheme and host. */
export function normalizeWorkerUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return url.trim().replace(/\/+$/, '');
  }
}

export interface RelayDeps {
  store: Store;
  bus: Bus;
  scheduler: Scheduler;
  asks: Asks;
  brain: { ask(text: string, opts?: { channel?: Channel }): Promise<BrainReply> };
  transport: RelayTransport;
  /** The Worker this relay talks to; the key for which reminders it already holds. */
  workerUrl?: string;
  now?: () => number;
  /** IANA zone sent with every reminder PUT. */
  timeZone?: () => string;
  retryDelaysMs?: readonly number[];
  log?: (message: string, err?: unknown) => void;
}

/** WhatsApp text for a mirrored note or ask. The agent's body is kept verbatim. */
export function formatForWhatsApp(m: Message): string {
  const footer = `— ${m.sender}${m.project ? ` · ${m.project}` : ''}`;
  const urgent = m.urgent ? '🚨 ' : '';
  if (m.kind === 'ask') {
    const options = m.options?.length ? `\nOptions: ${m.options.join(' / ')}` : '';
    return `${urgent}❓ ${m.body}${options}\n\n${footer}\n(Quote-reply to this message to answer.)`;
  }
  const head = m.title ? `${urgent}📝 ${m.title}\n` : `${urgent}📝 `;
  return `${head}${m.body}\n\n${footer}`;
}

export class Relay {
  readonly #d: RelayDeps;
  readonly #unsubscribe: (() => void)[] = [];
  readonly #timers = new Set<NodeJS.Timeout>();
  /** Worker calls go out one at a time, in order (a cancel never overtakes its create). */
  #chain: Promise<void> = Promise.resolve();
  #running = false;

  constructor(deps: RelayDeps) {
    this.#d = deps;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const { bus } = this.#d;
    this.#unsubscribe.push(
      bus.on('message:mirror', (m) => {
        // Ruling: mirror notes and asks only. Reminders go out from the Worker; desk chat is
        // not mirrored (only replies to WhatsApp messages are sent, from #inbound). The phone
        // gate decides when (at once if the user is away, else once they are).
        if (m.kind === 'note' || m.kind === 'ask') this.#mirror(m.id);
      }),
      bus.on('reminder:created', (r) => this.#putReminder(r.id)),
      bus.on('reminder:cancelled', (r) => this.#deleteReminder(r)),
    );
    this.#d.transport.start((frame) => this.handleFrame(frame));
  }

  stop(): void {
    this.#running = false;
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.#d.transport.stop();
  }

  /** Reconnect the socket now (after the PC wakes from sleep). */
  reconnect(): void {
    if (this.#running) this.#d.transport.reconnect();
  }

  /** Resolves once every queued Worker call has settled (tests). */
  idle(): Promise<void> {
    return this.#chain;
  }

  // ---- outbound -------------------------------------------------------------

  #mirror(messageId: string): void {
    this.#enqueue(`send ${messageId}`, async () => {
      const m = this.#d.store.getMessage(messageId);
      // Still worth sending? (Not already sent, not dealt with in the meantime.)
      if (!m || m.waId !== undefined) return;
      if (m.kind === 'ask' ? m.answer !== undefined : m.state === 'done') return;
      const { waId } = await this.#d.transport.send({ text: formatForWhatsApp(m), kind: m.kind, urgent: m.urgent });
      this.#d.store.updateMessage(m.id, { waId });
    });
  }

  #putReminder(reminderId: string): void {
    this.#enqueue(`put reminder ${reminderId}`, async () => {
      const r = this.#d.store.getScheduledReminder(reminderId);
      if (!r?.active) return; // cancelled (or finished) before we got to it
      await this.#d.transport.putReminder(r.id, {
        body: r.body,
        dueAt: r.dueAt,
        // A recurring rule is anchored at the reminder's original start (the `when` it was
        // created with), so the Worker counts COUNT from the same place as the desktop.
        ...(r.rrule !== undefined && { rrule: r.rrule, startAt: r.startAt }),
        tz: (this.#d.timeZone ?? defaultTimeZone)(),
      });
      this.#markSynced(r.id, true);
    });
  }

  #deleteReminder(r: Pick<Reminder, 'id'>): void {
    this.#enqueue(`delete reminder ${r.id}`, async () => {
      await this.#d.transport.deleteReminder(r.id);
      this.#markSynced(r.id, false);
    });
  }

  /**
   * Gap-fill (the caller runs it when a relay starts; never on an ordinary reconnect). PUTs
   * every active reminder still due in the future that this Worker never acknowledged, and
   * DELETEs the ones it holds that were cancelled or finished meanwhile (the relay was off,
   * or the DELETE failed). Running it again changes nothing: a reminder this Worker already
   * acknowledged is not PUT again.
   */
  syncExistingReminders(): void {
    if (!this.#running) return;
    const now = (this.#d.now ?? Date.now)();
    const synced = new Set(this.#synced());
    for (const r of this.#d.store.listActiveReminders()) {
      if (r.dueAt > now && !synced.has(r.id)) this.#putReminder(r.id);
    }
    for (const id of synced) {
      if (!this.#d.store.getReminder(id)?.active) this.#deleteReminder({ id });
    }
  }

  /**
   * Best-effort DELETE of every reminder this Worker holds, for when WhatsApp is switched off
   * or moved to another Worker (the Worker would otherwise go on sending them). Call it after
   * {@link stop}. Every recorded id is DELETEd in parallel, and so is any id the call still in
   * flight adds when it lands. Ids whose DELETE succeeds are forgotten; the rest stay
   * recorded, so a later gap-fill against the same Worker retries them.
   *
   * Never takes longer than `timeoutMs` in total, and gives up at once when `signal` aborts
   * (the app is quitting); a DELETE that answers after that changes nothing locally.
   * Resolves with the ids still recorded as held (empty when `signal` aborted it).
   */
  async withdrawReminders(options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<string[]> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), options.timeoutMs ?? WITHDRAW_TIMEOUT_MS);
    timer.unref?.();
    const onAbort = () => ctl.abort();
    options.signal?.addEventListener('abort', onAbort);
    if (options.signal?.aborted) ctl.abort();
    const gaveUp = new Promise<void>((resolve) => ctl.signal.addEventListener('abort', () => resolve()));
    const tried = new Set<string>();
    const deleteHeld = () =>
      Promise.allSettled(
        this.#synced()
          .filter((id) => !tried.has(id))
          .map(async (id) => {
            tried.add(id);
            try {
              await this.#d.transport.deleteReminder(id, ctl.signal);
            } catch (err) {
              if (!ctl.signal.aborted) this.#log(`relay: withdrawing reminder ${id} failed; kept for the next gap-fill`, err);
              return;
            }
            if (!ctl.signal.aborted) this.#markSynced(id, false);
          }),
      );
    // Delete what the Worker holds now and, once the call in flight (a PUT, say) has
    // settled, anything it added; a slow call in flight doesn't hold up the rest.
    const work = Promise.all([deleteHeld(), this.#chain.then(() => (ctl.signal.aborted ? undefined : deleteHeld()))]);
    try {
      await Promise.race([work, gaveUp]);
      if (ctl.signal.aborted && !options.signal?.aborted) this.#log('relay: withdrawing reminders timed out');
    } finally {
      ctl.abort(); // late answers change nothing
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
    return options.signal?.aborted ? [] : this.#synced();
  }

  get #syncedKey(): string | undefined {
    return this.#d.workerUrl === undefined ? undefined : SYNCED_KV_PREFIX + normalizeWorkerUrl(this.#d.workerUrl);
  }

  /** Ids of the reminders the current Worker holds (as far as we know). */
  #synced(): string[] {
    const key = this.#syncedKey;
    if (!key) return [];
    try {
      const raw = JSON.parse(this.#d.store.getKv(key) ?? '[]');
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  #markSynced(id: string, held: boolean): void {
    const key = this.#syncedKey;
    if (!key) return;
    const ids = new Set(this.#synced());
    if (held) ids.add(id);
    else ids.delete(id);
    this.#d.store.setKv(key, JSON.stringify([...ids]));
  }

  #sendChat(text: string, replyTo?: Message): void {
    this.#enqueue('send chat reply', async () => {
      const { waId } = await this.#d.transport.send({ text, kind: 'chat' });
      if (replyTo && replyTo.waId === undefined) this.#d.store.updateMessage(replyTo.id, { waId });
    });
  }

  /** Run `job` after the jobs before it; on a retryable failure, run it again later. */
  #enqueue(label: string, job: () => Promise<void>, attempt = 0): void {
    if (!this.#running) return;
    this.#chain = this.#chain.then(async () => {
      if (!this.#running) return;
      try {
        await job();
      } catch (err) {
        const delays = this.#d.retryDelaysMs ?? RETRY_DELAYS_MS;
        const permanent = err instanceof RelayHttpError && err.permanent;
        if (permanent || attempt >= delays.length) {
          this.#log(`relay: ${label} failed${permanent ? '' : ` after ${attempt + 1} attempts`}; giving up`, err);
          return;
        }
        this.#log(`relay: ${label} failed; retrying in ${Math.round(delays[attempt]! / 1000)} s`, err);
        const timer = setTimeout(() => {
          this.#timers.delete(timer);
          this.#enqueue(label, job, attempt + 1);
        }, delays[attempt]);
        timer.unref?.();
        this.#timers.add(timer);
      }
    });
  }

  // ---- inbound --------------------------------------------------------------

  /** Handle one Worker frame. Resolving means "handled, ack it". */
  async handleFrame(frame: WorkerToPc): Promise<void> {
    if (frame.type === 'reminder-fired') return this.#reminderFired(frame);
    return this.#inbound(frame);
  }

  #reminderFired(frame: RelayReminderFired): void {
    // A one-off the Worker fired is gone from the Worker: stop tracking it.
    if (frame.nextDueAt === undefined) this.#markSynced(frame.reminderId, false);
    this.#d.scheduler.applyRemoteFiring({
      reminderId: frame.reminderId,
      firedAt: frame.firedAt,
      ...(frame.waId !== undefined && { waId: frame.waId }),
      ...(frame.nextDueAt !== undefined && { nextDueAt: frame.nextDueAt }),
    });
  }

  #inbound(frame: RelayInbound): void {
    const { store, asks } = this.#d;
    const seen = this.#seen();
    if (seen.includes(frame.id)) return;
    const quoted = frame.contextWaId === undefined ? undefined : store.findMessageByWaId(frame.contextWaId);

    if (quoted?.kind === 'ask') {
      try {
        asks.answer(quoted.id, frame.text, 'whatsapp');
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const current = store.getMessage(quoted.id);
        const via = current?.answeredVia ? ` (via ${current.answeredVia})` : '';
        this.#sendChat(`📎 That question was already answered${via}: “${current?.answer ?? ''}”.`);
      }
      this.#markSeen(seen, frame.id);
      return;
    }

    // Anything else is chat for the brain (one shared session with the desk).
    store.createMessage({ kind: 'chat', role: 'user', sender: 'user', body: frame.text, waId: frame.id, state: 'done' });
    this.#markSeen(seen, frame.id);
    const prompt = quoted ? `(Replying to your earlier message: “${quoted.body}”)\n${frame.text}` : frame.text;
    void this.#d.brain.ask(prompt, { channel: 'whatsapp' }).then(
      (reply) => {
        if (reply.message) this.#sendChat(reply.message.body, reply.message);
        else this.#sendChat(`📎 ${reply.error ?? 'Clippy could not answer just now.'}`);
      },
      (err) => this.#log('relay: brain turn failed', err),
    );
  }

  #seen(): string[] {
    try {
      const raw = JSON.parse(this.#d.store.getKv(SEEN_KV_KEY) ?? '[]');
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  #markSeen(seen: string[], id: string): void {
    this.#d.store.setKv(SEEN_KV_KEY, JSON.stringify([...seen, id].slice(-SEEN_KEEP)));
  }

  #log(message: string, err?: unknown): void {
    if (this.#d.log) this.#d.log(message, err);
    else if (err === undefined) console.info(`[clippy] ${message}`);
    else console.warn(`[clippy] ${message}:`, err instanceof Error ? err.message : err);
  }
}

function defaultTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
