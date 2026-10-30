/**
 * Local HTTP API contract (desktop app ↔ MCP server / hook / ClippyClient).
 *
 * The server (desktop app) binds 127.0.0.1 on a random free port written to the
 * `port` file. Every request needs `Authorization: Bearer <token>` (token from
 * the `token` file); otherwise 401. Request/response bodies are JSON.
 * Errors are `{ error: string }` with a 4xx/5xx status (400 invalid input,
 * 401 bad/missing token, 403 not allowed, 404 unknown id).
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
 * - `restartApp` (body RestartAppBody) → PowerRequestResult (202): a question the user must confirm
 * - `restartPc` (body RestartPcBody) → PowerRequestResult (202): likewise
 * - `listApps` → OpenApp[] (windowed apps)
 * - `requestApproval` (body ApprovalRequestBody) → ApprovalResult (201 when `waiting`, else 200)
 * - `withdrawApproval` → 204, no body (also for an unknown or already closed approval)
 *
 * The three power routes answer 403 while the `allowPowerActions` setting is off.
 * `answerAsk` answers 403 for an open restart confirmation or phone approval: only the user's own
 * taps (in-process, from the desk and the phones) answer those.
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
  restartApp: { method: 'POST', path: '/power/restart-app' },
  restartPc: { method: 'POST', path: '/power/restart-pc' },
  listApps: { method: 'GET', path: '/power/apps' },
  requestApproval: { method: 'POST', path: '/approvals' },
  withdrawApproval: { method: 'POST', path: '/approvals/:id/withdraw' },
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

/**
 * An app name as `restart_app` takes it: the exe name with or without `.exe` (`chrome`,
 * `Code.exe`). Letters, digits, spaces and `_ . ( ) + -` only, so it never needs quoting.
 */
export const AppName = z
  .string()
  .trim()
  .regex(/^[\w .()+-]{1,100}$/, 'Use the program name, e.g. chrome or notepad.exe');

/** Why the user wants it, in their words; shown on the confirmation question. */
const PowerReason = z.string().trim().min(1).max(300);

/** `POST /power/restart-app` body. */
export const RestartAppBody = z.object({ name: AppName, reason: PowerReason.optional() });
export type RestartAppBody = z.infer<typeof RestartAppBody>;

/** `POST /power/restart-pc` body. */
export const RestartPcBody = z.object({ reason: PowerReason.optional() });
export type RestartPcBody = z.infer<typeof RestartPcBody>;

/**
 * A restart request, posted to the user as a question. Nothing happens until they tap Restart
 * (on the desk or a phone); the request answers at once and never waits for that.
 */
export const PowerRequestResult = z.object({
  /** Id of the confirmation question (an ask). */
  id: z.string(),
  status: z.literal('awaiting-confirmation'),
  /** The question the user is asked. */
  question: z.string(),
});
export type PowerRequestResult = z.infer<typeof PowerRequestResult>;

/** A running app with a window (`GET /power/apps`). */
export const OpenApp = z.object({
  /** Process name without `.exe`, e.g. `chrome`. */
  name: z.string(),
  pid: z.number().int(),
  /** Its main window's title (may be empty). */
  title: z.string(),
});
export type OpenApp = z.infer<typeof OpenApp>;

/**
 * How long the hook waits for the user's answer to a phone approval, seconds. It stays under
 * {@link APPROVAL_HOOK_TIMEOUT_S} (Claude Code cancels a hook at its timeout and discards its
 * output), so the hook can still withdraw the request and let the terminal prompt show.
 */
export const APPROVAL_WAIT_S = 1740;
/** The `timeout` of the `PermissionRequest` hook entry the installer writes, seconds. */
export const APPROVAL_HOOK_TIMEOUT_S = 1800;
/** The two buttons of a phone approval. */
export const APPROVAL_ALLOW = 'Allow';
export const APPROVAL_DENY = 'Deny';
/**
 * What Clippy itself answers an approval with when it closes one: it timed out or was left from
 * before a restart (Expired), the hook gave up waiting (Withdrawn), or the user dismissed the desk
 * note (Dismissed). Each means "no decision": the agent's terminal prompt shows instead.
 */
export const APPROVAL_EXPIRED = 'Expired';
export const APPROVAL_WITHDRAWN = 'Withdrawn';
export const APPROVAL_DISMISSED = 'Dismissed';

/**
 * `POST /approvals` body: an agent's permission request (the hook's `PermissionRequest` event).
 * `input` is the tool's input as Claude Code gave it (any JSON).
 */
export const ApprovalRequestBody = z.object({
  sessionId: z.string().max(200).optional(),
  cwd: z.string().max(1000).optional(),
  project: z.string().min(1).max(200).optional(),
  tool: z.string().min(1).max(200),
  input: z.unknown().optional(),
  sender: z.string().min(1).max(200),
});
export type ApprovalRequestBody = z.infer<typeof ApprovalRequestBody>;

/**
 * `POST /approvals` result. `off`: the `phoneApprovals` setting or the hook is off; `at-desk`: the
 * user is at the PC. Either way the agent gets its normal terminal prompt. `waiting`: the question
 * `id` (an ask) is on the desk and the phone; long-poll it with `GET /asks/:id?wait=`.
 */
export const ApprovalResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('off') }),
  z.object({ status: z.literal('at-desk') }),
  z.object({ status: z.literal('waiting'), id: z.string() }),
]);
export type ApprovalResult = z.infer<typeof ApprovalResult>;

/** Error response body for any non-2xx status. */
export const ApiError = z.object({ error: z.string() });
export type ApiError = z.infer<typeof ApiError>;
