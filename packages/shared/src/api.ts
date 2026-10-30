/**
 * Local HTTP API contract (desktop app ↔ MCP server / hook / ClippyClient).
 *
 * The server (desktop app) binds 127.0.0.1 on a random free port written to the
 * `port` file. Every request needs `Authorization: Bearer <token>` (token from
 * the `token` file); otherwise 401. Request/response bodies are JSON.
 * Errors are `{ error: string }` with a 4xx/5xx status (400 invalid input,
 * 401 bad/missing token, 404 unknown id).
 */
import { z } from 'zod';
import { AnsweredVia, Timestamp } from './schemas';

/** HTTP method of a route. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** A route: method + path pattern (`:id` is the only parameter). */
export interface RouteDef {
  readonly method: HttpMethod;
  readonly path: string;
}

/**
 * Every local API route. Response bodies:
 * - `health` → Health
 * - `postMessage` (body NewMessageInput) → Message (201)
 * - `listMessages` (query `state`, `kind`, `q` = FTS search) → Message[] (newest first)
 * - `markDone` → Message
 * - `snooze` (body SnoozeBody) → Message
 * - `createReminder` (body NewReminderInput) → Reminder (201)
 * - `listReminders` → Reminder[] (active ones, soonest first)
 * - `cancelReminder` → 204, no body
 * - `createAsk` (body NewAskInput) → Message of kind 'ask' (201)
 * - `listPendingAsks` → Message[] (unanswered asks)
 * - `getAsk` (query `wait` = seconds to long-poll, default 0) → AskResult
 * - `answerAsk` (body AnswerAskBody) → AskResult
 * - `listOrders` → StandingOrder[] (active ones, oldest first)
 * - `addOrder` (body NewStandingOrderInput) → StandingOrder (201)
 * - `cancelOrder` → 204, no body
 * - `listWatches` → Watch[] (active ones, oldest first)
 * - `addWatch` (body NewWatchInput) → Watch (201)
 * - `cancelWatch` → 204, no body
 */
export const Routes = {
  health: { method: 'GET', path: '/health' },
  postMessage: { method: 'POST', path: '/messages' },
  listMessages: { method: 'GET', path: '/messages' },
  markDone: { method: 'POST', path: '/messages/:id/done' },
  snooze: { method: 'POST', path: '/messages/:id/snooze' },
  createReminder: { method: 'POST', path: '/reminders' },
  listReminders: { method: 'GET', path: '/reminders' },
  cancelReminder: { method: 'DELETE', path: '/reminders/:id' },
  createAsk: { method: 'POST', path: '/asks' },
  listPendingAsks: { method: 'GET', path: '/asks/pending' },
  getAsk: { method: 'GET', path: '/asks/:id' },
  answerAsk: { method: 'POST', path: '/asks/:id/answer' },
  listOrders: { method: 'GET', path: '/orders' },
  addOrder: { method: 'POST', path: '/orders' },
  cancelOrder: { method: 'DELETE', path: '/orders/:id' },
  listWatches: { method: 'GET', path: '/watches' },
  addWatch: { method: 'POST', path: '/watches' },
  cancelWatch: { method: 'DELETE', path: '/watches/:id' },
} as const satisfies Record<string, RouteDef>;

/** Fill a route's `:id` placeholder (URL-encoded). */
export function routePath(route: RouteDef, id?: string): string {
  if (!route.path.includes(':id')) return route.path;
  if (id === undefined) throw new Error(`Route ${route.path} needs an id`);
  return route.path.replace(':id', encodeURIComponent(id));
}

/**
 * Longest single `GET /asks/:id?wait=` long-poll, seconds. The server clamps
 * `wait` to this; `ClippyClient.waitAsk` loops to wait longer (this also keeps
 * each request well under fetch/undici's 300 s headers timeout).
 */
export const MAX_LONG_POLL_S = 60;

/**
 * Longest `POST /asks` may spend looking for a standing order that answers the question before it
 * posts the ask as usual, ms. `ClippyClient.createAsk` allows for it on top of its normal timeout.
 */
export const MATCH_ORDER_TIMEOUT_MS = 20_000;

/** `GET /health` response. */
export const Health = z.object({
  ok: z.literal(true),
  /** Desktop app version. */
  version: z.string(),
});
export type Health = z.infer<typeof Health>;

/** `POST /messages/:id/snooze` body. */
export const SnoozeBody = z.object({ until: Timestamp });
export type SnoozeBody = z.infer<typeof SnoozeBody>;

/** `POST /asks/:id/answer` body. */
export const AnswerAskBody = z.object({ answer: z.string().min(1), via: AnsweredVia });
export type AnswerAskBody = z.infer<typeof AnswerAskBody>;

/** Error response body for any non-2xx status. */
export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;
