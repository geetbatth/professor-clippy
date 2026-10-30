/**
 * WhatsApp Cloud API sending: 24 h window choice, text shaping and the Graph call.
 * Pure helpers are exported for unit tests; `sendWhatsApp` is the only I/O.
 */
import { WA_TEMPLATE_NAME, WA_TRUNCATION_SUFFIX, templateParam } from '@clippy/shared/relay';

/** Graph API version used for every call. Bump here only. */
export const GRAPH_API_VERSION = 'v24.0';

/** Language code the `clippy_note` template is registered under. */
export const WA_TEMPLATE_LANGUAGE = 'en';

/** WhatsApp's customer-service window: free-form messages are allowed this long after the user's last message. */
export const SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Meta's limit for a free-form text body. */
export const WA_TEXT_MAX = 4096;

/** Meta error code for "free-form message outside the 24 h window". */
const RE_ENGAGEMENT_ERROR = 131047;

export type SendMode = 'freeform' | 'template';

/** Free-form inside 24 h of the user's last inbound message, template otherwise (or if they never wrote). */
export function chooseMode(now: number, lastInboundAt: number | undefined): SendMode {
  return lastInboundAt !== undefined && now - lastInboundAt < SERVICE_WINDOW_MS ? 'freeform' : 'template';
}

/**
 * Make text acceptable as a template body parameter. Meta rejects parameters with
 * newlines, tabs or more than 4 consecutive spaces (error 132018), so lines are
 * trimmed, blank lines dropped, the rest joined with " · ", and any whitespace run
 * collapsed to one space. Never returns an empty string (Meta rejects empty params).
 */
export function sanitizeTemplateText(text: string): string {
  const joined = text
    .split(/[\r\n\u2028\u2029\v\f]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join(' · ');
  return joined.length > 0 ? joined : '(empty note)';
}

/** Free-form text keeps its newlines; it is only cut to Meta's 4096-char limit (ending with the shared suffix). */
export function freeformText(text: string): string {
  if (text.length <= WA_TEXT_MAX) return text;
  let cut = WA_TEXT_MAX - WA_TRUNCATION_SUFFIX.length;
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1; // don't leave a lone high surrogate
  return text.slice(0, cut) + WA_TRUNCATION_SUFFIX;
}

/** Graph `/messages` request body for one message to `to` in the given mode. */
export function buildMessagePayload(mode: SendMode, to: string, text: string): Record<string, unknown> {
  if (mode === 'freeform') {
    return {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: freeformText(text) },
    };
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: WA_TEMPLATE_NAME,
      language: { code: WA_TEMPLATE_LANGUAGE },
      components: [
        { type: 'body', parameters: [{ type: 'text', text: templateParam(sanitizeTemplateText(text)) }] },
      ],
    },
  };
}

/** A non-2xx answer from the Graph API. */
export class MetaApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

export interface WhatsAppConfig {
  META_TOKEN: string;
  PHONE_NUMBER_ID: string;
  MY_NUMBER: string;
}

/** POST one message to the Graph API; returns the WhatsApp message id (wamid). */
async function postMessage(cfg: WhatsAppConfig, payload: Record<string, unknown>): Promise<string> {
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${cfg.PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.META_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const json = (await res.json().catch(() => ({}))) as {
    messages?: { id?: unknown }[];
    error?: { message?: unknown; code?: unknown };
  };
  const waId = json.messages?.[0]?.id;
  if (!res.ok || typeof waId !== 'string') {
    const code = typeof json.error?.code === 'number' ? json.error.code : undefined;
    const msg = typeof json.error?.message === 'string' ? json.error.message : `HTTP ${res.status}`;
    throw new MetaApiError(res.status, code, `WhatsApp send failed: ${msg}`);
  }
  return waId;
}

/**
 * Send `text` to the user's number. Uses free-form inside the 24 h window, else the
 * `clippy_note` template. If Meta says the window has in fact closed (131047), retries
 * once as a template.
 */
export async function sendWhatsApp(
  cfg: WhatsAppConfig,
  text: string,
  now: number,
  lastInboundAt: number | undefined,
): Promise<{ waId: string; mode: SendMode }> {
  const mode = chooseMode(now, lastInboundAt);
  try {
    return { waId: await postMessage(cfg, buildMessagePayload(mode, cfg.MY_NUMBER, text)), mode };
  } catch (err) {
    if (mode !== 'freeform' || !(err instanceof MetaApiError) || err.code !== RE_ENGAGEMENT_ERROR) throw err;
    return {
      waId: await postMessage(cfg, buildMessagePayload('template', cfg.MY_NUMBER, text)),
      mode: 'template',
    };
  }
}
