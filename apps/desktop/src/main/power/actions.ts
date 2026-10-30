/**
 * Power actions: restarting an app or the PC when the user asks Clippy's brain to (DECISIONS.md, "PC control" 1).
 *
 * The brain can only *request* one. A request is an urgent question from `Professor Clippy`
 * ("Restart Google Chrome (chrome.exe, 12 processes)? ...", options Restart / Cancel) and the
 * request returns at once (brain turns are queued, so nothing may wait for the user). The action
 * runs when the user answers Restart (or yes / y / ok) on the desk, in Telegram or on WhatsApp;
 * any other answer cancels it. Clippy itself can never confirm one: an answer `via: 'clippy'`
 * (the brain's `answer_pending`) is refused by an `Asks` guard (403), and ignored here as well.
 * Both of its questions carry `event: 'power-confirmation'` ({@link isPowerConfirmation}), so the
 * phone gate sends them to the phone at once, even while the user is at the PC (they may have
 * asked from the phone, and the restart waits on the answer).
 *
 * - Off unless the `allowPowerActions` setting is on (ForbiddenError, 403).
 * - A request answered more than {@link POWER_REQUEST_TTL_MS} after it was made only leaves a
 *   note that it expired; one nobody answers expires on its own at that age.
 * - A PC restart is scheduled with {@link PC_RESTART_DELAY_S} seconds' grace, and a second
 *   question ("Restarting your PC in 60 seconds.", option Cancel restart) aborts it when answered
 *   from anywhere, Clippy included.
 * - Pending requests live in the store's kv ({@link POWER_KV_KEY}). After a restart of Clippy
 *   `expireLeftovers()` answers them "Expired" (which updates the note and the phone copies)
 *   without running anything.
 * - Every outcome (done, failed, cancelled, expired) is a short note from Clippy.
 */
import type { AnsweredVia, Message, OpenApp, PowerRequestResult } from '@clippy/shared';
import { z } from 'zod';
import type { Asks } from '../core/asks';
import type { Bus } from '../core/bus';
import { systemClock, type Clock, type TimerHandle } from '../core/clock';
import { ForbiddenError } from '../core/errors';
import type { Store } from '../core/store';
import { findApp, restartApp } from './apps';
import { unavailableExecutor, type PowerExecutor } from './executor';

/** Sender of the confirmation questions. */
export const POWER_SENDER = 'Professor Clippy';
/** Sender of the result notes (Clippy's own notes). */
const NOTE_SENDER = 'clippy';
const NOTE_TITLE = '🔁 Restart';
/** kv key of the pending requests (JSON array). */
export const POWER_KV_KEY = 'powerRequests';
/** A confirmation older than this no longer counts. */
export const POWER_REQUEST_TTL_MS = 10 * 60 * 1000;
/** Grace before a confirmed PC restart, seconds. */
export const PC_RESTART_DELAY_S = 60;
/** How long the Cancel restart question stays live: the grace plus a little. */
const CANCEL_TTL_MS = (PC_RESTART_DELAY_S + 30) * 1000;

export const RESTART = 'Restart';
export const CANCEL = 'Cancel';
export const CANCEL_RESTART = 'Cancel restart';
/** What an expired request is answered with. */
export const EXPIRED = 'Expired';
/** The `event` of both questions (what the phone gate recognises them by). */
export const POWER_EVENT = 'power-confirmation';

export const POWER_OFF_MESSAGE =
  "Restarting apps and the PC is turned off. Turn on 'Let Clippy restart apps and the PC' in Clippy's Settings.";
export const ONLY_USER_CONFIRMS_MESSAGE = 'Only you can confirm a restart: tap it on the note or in Telegram.';
/** The reason Windows shows in its restart warning. */
const SHUTDOWN_MESSAGE = 'Professor Clippy is restarting your PC because you asked him to.';

const PendingRequest = z.discriminatedUnion('kind', [
  z.object({ id: z.string(), kind: z.literal('restart-app'), exe: z.string(), label: z.string(), createdAt: z.number() }),
  z.object({ id: z.string(), kind: z.literal('restart-pc'), createdAt: z.number() }),
  z.object({ id: z.string(), kind: z.literal('cancel-pc-restart'), createdAt: z.number() }),
]);
type PendingRequest = z.infer<typeof PendingRequest>;

/** Is `m` one of the restart questions? Only the app creates those (agents can't set `event` on an ask). */
export function isPowerConfirmation(m: Pick<Message, 'kind' | 'event'>): boolean {
  return m.kind === 'ask' && m.event === POWER_EVENT;
}

/** Answers that confirm a restart: Restart, yes, y, ok (trimmed, any case). */
export function confirmsRestart(answer: string): boolean {
  return /^(restart|yes|y|ok)$/i.test(answer.trim());
}

export interface PowerActionsOptions {
  store: Store;
  bus: Bus;
  asks: Asks;
  /** The `allowPowerActions` setting, read on every request and again before acting. */
  allowed: () => boolean;
  /** Default {@link unavailableExecutor}: everything fails, nothing runs. The app passes the Windows one. */
  executor?: PowerExecutor;
  clock?: Clock;
  log?: (message: string, err?: unknown) => void;
}

export class PowerActions {
  readonly #o: PowerActionsOptions;
  readonly #exec: PowerExecutor;
  readonly #clock: Clock;
  readonly #timers = new Map<string, TimerHandle>();
  readonly #unsubscribe: (() => void)[] = [];
  /** Actions still running (tests await them). */
  readonly #running = new Set<Promise<void>>();

  constructor(options: PowerActionsOptions) {
    this.#o = options;
    this.#exec = options.executor ?? unavailableExecutor;
    this.#clock = options.clock ?? systemClock;
    this.#unsubscribe.push(
      options.asks.guard((ask, via) => {
        if (via === 'clippy' && this.isConfirmation(ask.id)) throw new ForbiddenError(ONLY_USER_CONFIRMS_MESSAGE);
      }),
      options.bus.on('ask:answered', ({ message }) => this.#onAnswered(message)),
    );
  }

  /** Running apps with a window. */
  async listApps(): Promise<OpenApp[]> {
    this.#assertAllowed();
    return this.#exec.listOpenApps();
  }

  /**
   * Ask the user to confirm restarting an app. Throws ForbiddenError (setting off, or an app
   * that may not be restarted), NotFoundError (not running) or ValidationError (not a name).
   */
  async requestRestartApp(name: string, reason?: string): Promise<PowerRequestResult> {
    this.#assertAllowed();
    const target = await findApp(this.#exec, name);
    const n = target.processes.length;
    const what = target.label === target.exe ? `${target.exe} (${n} ${plural(n)})` : `${target.label} (${target.exe}, ${n} ${plural(n)})`;
    const question = `Restart ${what}? Unsaved work in it may be lost.${reasonLine(reason)}`;
    return this.#ask(question, { kind: 'restart-app', exe: target.exe, label: target.label });
  }

  /** Ask the user to confirm restarting the PC. Throws ForbiddenError while the setting is off. */
  async requestRestartPc(reason?: string): Promise<PowerRequestResult> {
    this.#assertAllowed();
    const question = `Restart your PC? Every app will close and unsaved work may be lost.${reasonLine(reason)}`;
    return this.#ask(question, { kind: 'restart-pc' });
  }

  /** Is `askId` an open restart confirmation (one only the user may answer)? */
  isConfirmation(askId: string): boolean {
    const request = this.#pending().find((r) => r.id === askId);
    return request !== undefined && request.kind !== 'cancel-pc-restart';
  }

  /**
   * Expire every request left from before Clippy restarted: each is answered "Expired" (the
   * note and the phone copies show it) and nothing runs. Call once the phone channels listen.
   */
  expireLeftovers(): void {
    for (const request of this.#pending()) this.#expire(request.id);
  }

  /** Wait for actions still running (tests). */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.all([...this.#running]);
  }

  /** Stop listening and drop the expiry timers. Pending requests stay in kv for `expireLeftovers`. */
  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const timer of this.#timers.values()) this.#clock.clearTimeout(timer);
    this.#timers.clear();
  }

  // ---- internals --------------------------------------------------------------

  #assertAllowed(): void {
    if (!this.#o.allowed()) throw new ForbiddenError(POWER_OFF_MESSAGE);
  }

  #ask(question: string, request: { kind: 'restart-app'; exe: string; label: string } | { kind: 'restart-pc' }): PowerRequestResult {
    const ask = this.#o.asks.create({ question, options: [RESTART, CANCEL], sender: POWER_SENDER, urgent: true, event: POWER_EVENT });
    this.#add({ ...request, id: ask.id, createdAt: ask.createdAt }, POWER_REQUEST_TTL_MS);
    return { id: ask.id, status: 'awaiting-confirmation', question };
  }

  #pending(): PendingRequest[] {
    const raw = this.#o.store.getKv(POWER_KV_KEY);
    if (!raw) return [];
    try {
      const parsed = z.array(PendingRequest).safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  #save(requests: PendingRequest[]): void {
    if (requests.length === 0) this.#o.store.deleteKv(POWER_KV_KEY);
    else this.#o.store.setKv(POWER_KV_KEY, JSON.stringify(requests));
  }

  #add(request: PendingRequest, ttlMs: number): void {
    this.#save([...this.#pending(), request]);
    this.#timers.set(request.id, this.#clock.setTimeout(() => this.#expire(request.id), ttlMs));
  }

  /** Forget a request; returns it if it was pending. */
  #take(id: string): PendingRequest | undefined {
    const all = this.#pending();
    const request = all.find((r) => r.id === id);
    if (!request) return undefined;
    this.#save(all.filter((r) => r.id !== id));
    const timer = this.#timers.get(id);
    if (timer !== undefined) this.#clock.clearTimeout(timer);
    this.#timers.delete(id);
    return request;
  }

  /** Forget the request first (so neither the guard nor the listener acts on it), then close its question. */
  #expire(id: string): void {
    if (!this.#take(id)) return;
    try {
      this.#o.asks.answer(id, EXPIRED, 'clippy');
    } catch {
      // Already answered or gone: nothing left to close.
    }
  }

  #onAnswered(message: Message): void {
    const via: AnsweredVia | undefined = message.answeredVia;
    const request = this.#pending().find((r) => r.id === message.id);
    if (!request) return;
    // Never from Clippy (the guard already refuses that); the Cancel restart question is the exception.
    if (via === 'clippy' && request.kind !== 'cancel-pc-restart') return;
    this.#take(request.id);
    const answer = message.answer ?? '';

    if (request.kind === 'cancel-pc-restart') {
      this.#track(this.#cancelPcRestart());
      return;
    }
    const what = request.kind === 'restart-app' ? request.label : 'your PC';
    if (this.#clock.now() - request.createdAt > POWER_REQUEST_TTL_MS) {
      this.#note(`The request to restart ${what} expired before you answered (after 10 minutes), so I did nothing. Ask me again if you still want it.`);
      return;
    }
    if (!confirmsRestart(answer)) {
      this.#note(request.kind === 'restart-app' ? `Cancelled: I left ${what} alone.` : 'Cancelled: your PC stays on.');
      return;
    }
    if (!this.#o.allowed()) {
      this.#note(`Restarting is turned off in Settings now, so I left ${what} alone.`);
      return;
    }
    this.#track(request.kind === 'restart-app' ? this.#restartApp(request.exe, request.label) : this.#restartPc());
  }

  async #restartApp(exe: string, label: string): Promise<void> {
    try {
      const outcome = await restartApp(this.#exec, exe);
      this.#note(outcome.relaunched ? `Restarted ${outcome.label}.` : `Restarted ${outcome.label} (it started itself again).`);
    } catch (err) {
      this.#note(`I could not restart ${label}: ${errorText(err)}`);
    }
  }

  async #restartPc(): Promise<void> {
    try {
      await this.#exec.scheduleRestart(PC_RESTART_DELAY_S, SHUTDOWN_MESSAGE);
    } catch (err) {
      this.#note(`I could not restart your PC: ${errorText(err)}`);
      return;
    }
    const ask = this.#o.asks.create({
      question: `Restarting your PC in ${PC_RESTART_DELAY_S} seconds.`,
      options: [CANCEL_RESTART],
      sender: POWER_SENDER,
      urgent: true,
      event: POWER_EVENT,
    });
    this.#add({ id: ask.id, kind: 'cancel-pc-restart', createdAt: ask.createdAt }, CANCEL_TTL_MS);
  }

  async #cancelPcRestart(): Promise<void> {
    try {
      await this.#exec.abortRestart();
      this.#note('Restart cancelled. Your PC stays on.');
    } catch (err) {
      this.#note(`I could not cancel the restart: ${errorText(err)}`);
    }
  }

  #note(body: string): void {
    try {
      this.#o.store.createMessage({ kind: 'note', sender: NOTE_SENDER, title: NOTE_TITLE, body });
    } catch (err) {
      this.#o.log?.('power: could not leave a note', err);
    }
  }

  #track(action: Promise<void>): void {
    const tracked = action.finally(() => this.#running.delete(tracked));
    this.#running.add(tracked);
  }
}

const plural = (n: number) => (n === 1 ? 'process' : 'processes');
const reasonLine = (reason: string | undefined) => (reason?.trim() ? ` Reason: ${reason.trim()}` : '');
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
