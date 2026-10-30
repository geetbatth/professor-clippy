/**
 * Phone approvals: while the user is away, an agent's "allow this tool use?" prompt goes to the
 * desk note and the phone with Allow / Deny, and the user's tap answers the agent (DECISIONS.md,
 * "Phone approvals").
 *
 * The hook (`apps/hook`, Claude Code's `PermissionRequest` event) calls `POST /approvals`, then
 * long-polls the ask with `GET /asks/:id?wait=`; it maps the answer to allow / deny itself.
 *
 * - `off` unless the `phoneApprovals` setting and the hook are on; `at-desk` while the user is at
 *   the PC (the agent gets its normal terminal prompt either way). Otherwise an urgent ask from the
 *   agent (options Allow / Deny, `event: 'agent-permission-request'`) goes up, and the phone gate
 *   sends it to the phone at once.
 * - Only the user answers one. An `Asks` guard refuses `via: 'clippy'` (the brain's
 *   `answer_pending`) with a 403, and `POST /asks/:id/answer` refuses every answer to an open one
 *   (`isOpen`), since other agents use that API. Standing orders never see one: approvals are
 *   created here, in-process, not through `POST /asks`, which is where orders are matched.
 * - Clippy closes one itself (answered via `clippy`, which the hook takes as "no decision"):
 *   "Withdrawn" when the hook gives up, "Expired" after {@link APPROVAL_TTL_MS} or when left from
 *   before a restart (`expireLeftovers`), "Dismissed" when the user dismisses the desk note.
 * - Open approvals live in the store's kv ({@link APPROVALS_KV_KEY}), like power requests.
 */
import {
  APPROVAL_ALLOW,
  APPROVAL_DENY,
  APPROVAL_DISMISSED,
  APPROVAL_EXPIRED,
  APPROVAL_WAIT_S,
  APPROVAL_WITHDRAWN,
  type ApprovalRequestBody,
  type ApprovalResult,
  type Message,
} from '@clippy/shared';
import { basename } from 'node:path';
import { z } from 'zod';
import type { Asks } from '../core/asks';
import type { Bus } from '../core/bus';
import { systemClock, type Clock, type TimerHandle } from '../core/clock';
import { ForbiddenError } from '../core/errors';
import type { Store } from '../core/store';
import { approvalQuestion } from './question';

/** kv key of the open approvals (JSON array). */
export const APPROVALS_KV_KEY = 'approvalRequests';
/** An approval nobody answered closes itself after the hook's wait plus a minute. */
export const APPROVAL_TTL_MS = (APPROVAL_WAIT_S + 60) * 1000;
/** The `event` of an approval's ask (what the phone gate and watches recognise it by). */
export const APPROVAL_EVENT = 'agent-permission-request';

export const ONLY_USER_APPROVES_MESSAGE = "Only you can approve an agent's permission request: tap it on the note or in Telegram.";

const OpenApproval = z.object({ id: z.string(), createdAt: z.number(), sessionId: z.string().optional() });
type OpenApproval = z.infer<typeof OpenApproval>;

/** Is `m` a phone approval's question? Only the app creates those (agents can't set `event` on an ask). */
export function isApprovalAsk(m: Pick<Message, 'kind' | 'event'>): boolean {
  return m.kind === 'ask' && m.event === APPROVAL_EVENT;
}

export interface ApprovalsOptions {
  store: Store;
  bus: Bus;
  asks: Asks;
  /** The `phoneApprovals` setting and `hookEnabled`, read on every request. */
  enabled: () => boolean;
  /** Is the user at the PC (input within the away threshold)? Absent: always away. */
  isUserActive?: () => boolean;
  clock?: Clock;
}

export class Approvals {
  readonly #o: ApprovalsOptions;
  readonly #clock: Clock;
  readonly #timers = new Map<string, TimerHandle>();
  readonly #unsubscribe: (() => void)[] = [];

  constructor(options: ApprovalsOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
    this.#unsubscribe.push(
      options.asks.guard((ask, via) => {
        if (via === 'clippy' && this.isOpen(ask.id)) throw new ForbiddenError(ONLY_USER_APPROVES_MESSAGE);
      }),
      // Answered by the user: nothing left to expire.
      options.bus.on('ask:answered', ({ message }) => void this.#take(message.id)),
      // Dismissed on the desk without an answer: let the agent's terminal prompt show.
      options.bus.on('message:updated', (m) => {
        if (m.state === 'done' && m.answer === undefined && this.isOpen(m.id)) this.#close(m.id, APPROVAL_DISMISSED);
      }),
    );
  }

  /**
   * An agent wants permission to use a tool. Posts the question only when the setting is on and
   * the user is away; never waits for the answer (the hook long-polls the ask).
   */
  request(input: ApprovalRequestBody): ApprovalResult {
    if (!this.#o.enabled()) return { status: 'off' };
    if (this.#o.isUserActive?.() ?? false) return { status: 'at-desk' };
    const project = input.project ?? (input.cwd ? basename(input.cwd) || undefined : undefined);
    const ask = this.#o.asks.create({
      question: approvalQuestion({ project, tool: input.tool, input: input.input }),
      options: [APPROVAL_ALLOW, APPROVAL_DENY],
      sender: input.sender,
      ...(project !== undefined && { project }),
      urgent: true,
      event: APPROVAL_EVENT,
    });
    // The ask is already out (message:new) before it is recorded here; nothing answers it in between.
    const open: OpenApproval = { id: ask.id, createdAt: ask.createdAt, ...(input.sessionId !== undefined && { sessionId: input.sessionId }) };
    this.#save([...this.#open(), open]);
    this.#timers.set(ask.id, this.#clock.setTimeout(() => this.#close(ask.id, APPROVAL_EXPIRED), APPROVAL_TTL_MS));
    return { status: 'waiting', id: ask.id };
  }

  /** Is `askId` an open approval (one only the user may answer)? */
  isOpen(askId: string): boolean {
    return this.#open().some((a) => a.id === askId);
  }

  /** The hook stopped waiting: close the question ("Withdrawn") if it is still open. */
  withdraw(askId: string): void {
    this.#close(askId, APPROVAL_WITHDRAWN);
  }

  /**
   * Close every approval left from before Clippy restarted ("Expired": the desk note and the
   * phone copies show it). Call once the phone channels listen.
   */
  expireLeftovers(): void {
    for (const approval of this.#open()) this.#close(approval.id, APPROVAL_EXPIRED);
  }

  /** Stop listening and drop the expiry timers. Open approvals stay in kv for `expireLeftovers`. */
  dispose(): void {
    for (const off of this.#unsubscribe.splice(0)) off();
    for (const timer of this.#timers.values()) this.#clock.clearTimeout(timer);
    this.#timers.clear();
  }

  // ---- internals --------------------------------------------------------------

  #open(): OpenApproval[] {
    const raw = this.#o.store.getKv(APPROVALS_KV_KEY);
    if (!raw) return [];
    try {
      const parsed = z.array(OpenApproval).safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : [];
    } catch {
      return [];
    }
  }

  #save(approvals: OpenApproval[]): void {
    if (approvals.length === 0) this.#o.store.deleteKv(APPROVALS_KV_KEY);
    else this.#o.store.setKv(APPROVALS_KV_KEY, JSON.stringify(approvals));
  }

  /** Forget an approval; true if it was open. */
  #take(id: string): boolean {
    const all = this.#open();
    if (!all.some((a) => a.id === id)) return false;
    this.#save(all.filter((a) => a.id !== id));
    const timer = this.#timers.get(id);
    if (timer !== undefined) this.#clock.clearTimeout(timer);
    this.#timers.delete(id);
    return true;
  }

  /** Forget it first (so the guard lets Clippy's own answer through), then answer it `answer`. */
  #close(id: string, answer: string): void {
    if (!this.#take(id)) return;
    try {
      this.#o.asks.answer(id, answer, 'clippy');
    } catch {
      // Already answered or gone: nothing left to close.
    }
  }
}
