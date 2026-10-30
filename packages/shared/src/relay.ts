/**
 * Relay protocol between the desktop app (PC) and the Cloudflare Worker that
 * fronts the WhatsApp Cloud API.
 *
 * PC → Worker: REST with `Authorization: Bearer <workerSecret>` (see {@link RelayRoutes}),
 * plus a long-lived WebSocket from `GET /ws` (same auth header) that the PC opens outbound.
 * Worker → PC over the socket: {@link WorkerToPc}. PC → Worker over the socket: {@link PcToWorker}.
 * Every Worker→PC item has an `id`; the PC acks ids once handled, and anything
 * unacked is redelivered on reconnect (so PC handlers must be idempotent by `id`).
 *
 * No Node imports: safe to use inside the Worker.
 */
import { z } from 'zod';
import { MessageKind, Timestamp } from './schemas';

/** Relay REST/WS routes on the Worker (`:id` = reminder id, same ULID as the desktop Reminder). */
export const RelayRoutes = {
  /** Body {@link RelaySendRequest} → {@link RelaySendResponse}. */
  send: { method: 'POST', path: '/send' },
  /** Create or replace a reminder so the Worker's cron can fire it while the PC is off. Body {@link RelayReminderPut} → 204. */
  putReminder: { method: 'PUT', path: '/reminders/:id' },
  /** Cancel a synced reminder → 204. */
  deleteReminder: { method: 'DELETE', path: '/reminders/:id' },
  /** WebSocket upgrade. */
  ws: { method: 'GET', path: '/ws' },
} as const satisfies Record<string, { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string }>;

/** `POST /send`: mirror one message to WhatsApp. */
export const RelaySendRequest = z.object({
  text: z.string().min(1),
  kind: MessageKind,
  urgent: z.boolean().optional(),
});
export type RelaySendRequest = z.infer<typeof RelaySendRequest>;

/**
 * `POST /send` response. `mode` is `freeform` inside 24 h of the user's last
 * inbound WhatsApp message, else `template` ({@link WA_TEMPLATE_NAME}).
 * `waId` is the WhatsApp message id (stored on the Message to match quote-replies).
 */
export const RelaySendResponse = z.object({
  waId: z.string(),
  mode: z.enum(['freeform', 'template']),
});
export type RelaySendResponse = z.infer<typeof RelaySendResponse>;

/** True if `tz` is an IANA time zone this runtime knows (e.g. `America/Los_Angeles`). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `PUT /reminders/:id` body. */
export const RelayReminderPut = z.object({
  body: z.string().min(1),
  dueAt: Timestamp,
  /** RFC 5545 RRULE for recurring reminders. */
  rrule: z.string().min(1).optional(),
  /**
   * IANA time zone the RRULE is evaluated in (the PC's local zone). The rule runs on
   * floating local wall time anchored at `dueAt`'s wall time, so "09:00" stays 09:00
   * local across DST. Omitted: UTC.
   */
  tz: z.string().min(1).refine(isValidTimeZone, 'Unknown IANA time zone').optional(),
});
export type RelayReminderPut = z.infer<typeof RelayReminderPut>;

/** Worker → PC: the user sent a WhatsApp message. */
export const RelayInbound = z.object({
  type: z.literal('inbound'),
  /** Delivery id (ack this). */
  id: z.string(),
  text: z.string(),
  /** `context.id` of a quote-reply: if it equals an ask's `waId`, the text answers that ask; otherwise it is chat for the brain. */
  contextWaId: z.string().optional(),
  /** When WhatsApp received it, epoch ms. */
  ts: Timestamp,
});
export type RelayInbound = z.infer<typeof RelayInbound>;

/** Worker → PC: the Worker's cron fired a synced reminder (and sent it to WhatsApp). */
export const RelayReminderFired = z.object({
  type: z.literal('reminder-fired'),
  /**
   * Delivery id (ack this): `<reminderId>:<firedAt>`, unique per firing, so a late ack
   * can never delete a newer firing. Every firing is kept until acked.
   */
  id: z.string(),
  /** The reminder's id (same ULID as the desktop Reminder and `PUT /reminders/:id`). */
  reminderId: z.string(),
  firedAt: Timestamp,
  /** WhatsApp message id of the reminder notification, if sent. */
  waId: z.string().optional(),
  /** Next occurrence for recurring reminders; absent when the reminder is finished. */
  nextDueAt: Timestamp.optional(),
});
export type RelayReminderFired = z.infer<typeof RelayReminderFired>;

/** Any Worker → PC WebSocket frame (JSON). */
export const WorkerToPc = z.discriminatedUnion('type', [RelayInbound, RelayReminderFired]);
export type WorkerToPc = z.infer<typeof WorkerToPc>;

/** PC → Worker: these delivery ids were handled; stop redelivering them. */
export const RelayAck = z.object({
  type: z.literal('ack'),
  ids: z.array(z.string()),
});
export type RelayAck = z.infer<typeof RelayAck>;

/** Any PC → Worker WebSocket frame (JSON). */
export const PcToWorker = z.discriminatedUnion('type', [RelayAck]);
export type PcToWorker = z.infer<typeof PcToWorker>;

/** Meta utility template used outside the 24 h customer-service window. One body param `{{1}}`. */
export const WA_TEMPLATE_NAME = 'clippy_note';

/** Max length of the template's `{{1}}` parameter, including the truncation suffix. */
export const WA_TEMPLATE_PARAM_MAX = 1000;

/** Appended when the template parameter had to be cut. */
export const WA_TRUNCATION_SUFFIX = '…more on desktop';

/**
 * Text for the template's `{{1}}`: unchanged if it fits in {@link WA_TEMPLATE_PARAM_MAX}
 * characters, otherwise cut so that text + {@link WA_TRUNCATION_SUFFIX} is exactly that long.
 * Counts UTF-16 code units, never splitting a surrogate pair.
 */
export function templateParam(text: string): string {
  if (text.length <= WA_TEMPLATE_PARAM_MAX) return text;
  let cut = WA_TEMPLATE_PARAM_MAX - WA_TRUNCATION_SUFFIX.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // don't leave a lone high surrogate
  return text.slice(0, cut) + WA_TRUNCATION_SUFFIX;
}
