/** Test helpers shared by the worker test files. */
import { vi } from 'vitest';

/** `sha256=<hex>` HMAC of `data`, as Meta sends it in `X-Hub-Signature-256`. */
export async function signBody(key: string, data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const k = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, bytes));
  return 'sha256=' + Array.from(mac, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface WaMessage {
  from: string;
  id: string;
  /** Epoch seconds as a string, like Meta. */
  timestamp: string;
  type: string;
  text?: { body: string };
  context?: { from: string; id: string };
}

/** A realistic `messages` webhook payload carrying the given messages. */
export function webhookPayload(messages: WaMessage[], extraValue: Record<string, unknown> = {}): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA_ID',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: '1234567890' },
              contacts: [{ profile: { name: 'Me' }, wa_id: messages[0]?.from ?? '' }],
              messages,
              ...extraValue,
            },
          },
        ],
      },
    ],
  };
}

export interface GraphCall {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

/**
 * Replace `fetch` with a fake Graph API: every POST to graph.facebook.com gets
 * `wamid.<n>` back (or the response from `respond`). Any other fetch throws, so no
 * test can reach the network.
 */
export function mockGraph(
  respond?: (call: GraphCall, n: number) => Response | undefined | Promise<Response | undefined>,
): GraphCall[] {
  const calls: GraphCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname !== 'graph.facebook.com') throw new Error(`unexpected fetch ${req.url}`);
    const call = { url: req.url, auth: req.headers.get('authorization'), body: (await req.json()) as Record<string, unknown> };
    calls.push(call);
    return (await respond?.(call, calls.length)) ?? Response.json({ messages: [{ id: `wamid.${calls.length}` }] });
  });
  return calls;
}

/** The text WhatsApp would show for a Graph `/messages` body (free-form body or template `{{1}}`). */
export function sentText(body: Record<string, unknown>): string {
  if (body.type === 'text') return (body.text as { body: string }).body;
  const t = body.template as { components: { parameters: { text: string }[] }[] };
  return t.components[0]!.parameters[0]!.text;
}
