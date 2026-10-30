/** Parsing Meta's WhatsApp webhook payloads (after the signature has been checked). */
import { z } from 'zod';

/** One inbound text message from the user, ready to queue for the PC. */
export interface InboundText {
  /** WhatsApp message id (wamid); also the delivery id the PC acks. */
  id: string;
  text: string;
  contextWaId?: string;
  /** When WhatsApp received it, epoch ms. */
  ts: number;
}

const WebhookMessage = z.object({
  from: z.string(),
  id: z.string().min(1),
  timestamp: z.string(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  context: z.object({ id: z.string() }).optional(),
});

const WebhookPayload = z.object({
  entry: z.array(
    z.object({
      changes: z.array(
        z.object({
          field: z.string().optional(),
          value: z.object({ messages: z.array(z.unknown()).optional() }).optional(),
        }),
      ),
    }),
  ),
});

/** Digits only, so `+44 7700 900123` and `447700900123` compare equal. */
export function normalizeNumber(n: string): string {
  return n.replace(/\D/g, '');
}

/**
 * Text messages from `myNumber` in a webhook payload. Everything else (status
 * updates, other senders, media, malformed entries) is ignored. `now` is used when
 * Meta's timestamp is unusable.
 */
export function extractInboundTexts(payload: unknown, myNumber: string, now: number): InboundText[] {
  const parsed = WebhookPayload.safeParse(payload);
  const me = normalizeNumber(myNumber);
  if (!parsed.success || me.length === 0) return [];
  const out: InboundText[] = [];
  for (const entry of parsed.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== undefined && change.field !== 'messages') continue;
      for (const raw of change.value?.messages ?? []) {
        const msg = WebhookMessage.safeParse(raw);
        if (!msg.success) continue;
        const m = msg.data;
        if (m.type !== 'text' || m.text === undefined || normalizeNumber(m.from) !== me) continue;
        const secs = Number(m.timestamp);
        out.push({
          id: m.id,
          text: m.text.body,
          ...(m.context ? { contextWaId: m.context.id } : {}),
          ts: Number.isFinite(secs) && secs > 0 ? secs * 1000 : now,
        });
      }
    }
  }
  return out;
}
