import { WA_TEMPLATE_NAME, WA_TEMPLATE_PARAM_MAX, WA_TRUNCATION_SUFFIX } from '@clippy/shared/relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GRAPH_API_VERSION,
  MetaApiError,
  SERVICE_WINDOW_MS,
  WA_TEXT_MAX,
  buildMessagePayload,
  chooseMode,
  freeformText,
  isTransientSendError,
  sanitizeTemplateText,
  sendWhatsApp,
} from '../src/whatsapp';

const cfg = { META_TOKEN: 'tok', PHONE_NUMBER_ID: '555', MY_NUMBER: '447700900123' };

/** The `{{1}}` text of a template payload. */
function param(payload: Record<string, unknown>): string {
  const t = payload.template as { components: { parameters: { text: string }[] }[] };
  return t.components[0]!.parameters[0]!.text;
}

describe('chooseMode (24 h window)', () => {
  const now = 1_800_000_000_000;
  it('uses a template when the user never wrote', () => {
    expect(chooseMode(now, undefined)).toBe('template');
  });
  it('uses free-form strictly inside 24 h of the last inbound message', () => {
    expect(chooseMode(now, now)).toBe('freeform');
    expect(chooseMode(now, now - SERVICE_WINDOW_MS + 1)).toBe('freeform');
  });
  it('uses a template at and after 24 h', () => {
    expect(chooseMode(now, now - SERVICE_WINDOW_MS)).toBe('template');
    expect(chooseMode(now, now - SERVICE_WINDOW_MS - 60_000)).toBe('template');
  });
});

describe('sanitizeTemplateText (Meta error 132018)', () => {
  it('joins lines with " · " and drops blank ones', () => {
    expect(sanitizeTemplateText('Build failed\n\n  - step 3\r\nsee log\r\n')).toBe('Build failed · - step 3 · see log');
  });
  it('collapses tabs and long space runs', () => {
    expect(sanitizeTemplateText('a\tb     c\u00a0\u00a0 d')).toBe('a b c d');
  });
  it('treats other line separators as newlines', () => {
    expect(sanitizeTemplateText('a\u2028b\u2029c\vd\fe')).toBe('a · b · c · d · e');
  });
  it('never returns an empty parameter', () => {
    expect(sanitizeTemplateText(' \n\t\n ')).toBe('(empty note)');
  });
  it('leaves single-line text untouched', () => {
    expect(sanitizeTemplateText('Deploy done ✅ (3 services)')).toBe('Deploy done ✅ (3 services)');
  });
});

describe('buildMessagePayload', () => {
  it('builds the clippy_note template with a sanitised, truncated {{1}}', () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i}\twith     gaps`).join('\n');
    const p = buildMessagePayload('template', cfg.MY_NUMBER, text);
    expect(p).toMatchObject({
      messaging_product: 'whatsapp',
      to: cfg.MY_NUMBER,
      type: 'template',
      template: { name: WA_TEMPLATE_NAME, language: { code: 'en' } },
    });
    const v = param(p);
    expect(v).toHaveLength(WA_TEMPLATE_PARAM_MAX);
    expect(v.endsWith(WA_TRUNCATION_SUFFIX)).toBe(true);
    expect(v).not.toMatch(/[\n\t]| {5}/);
    expect(v.startsWith('line 0 with gaps · line 1 with gaps')).toBe(true);
  });
  it('keeps short template text whole', () => {
    expect(param(buildMessagePayload('template', cfg.MY_NUMBER, 'hi'))).toBe('hi');
  });
  it('sends free-form text with its newlines intact', () => {
    const p = buildMessagePayload('freeform', cfg.MY_NUMBER, 'line 1\n\tline 2');
    expect(p).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: cfg.MY_NUMBER,
      type: 'text',
      text: { preview_url: false, body: 'line 1\n\tline 2' },
    });
  });
});

describe('freeformText', () => {
  it('cuts to the 4096 limit with the shared suffix', () => {
    const out = freeformText('x'.repeat(5000));
    expect(out).toHaveLength(WA_TEXT_MAX);
    expect(out.endsWith(WA_TRUNCATION_SUFFIX)).toBe(true);
    expect(freeformText('x'.repeat(WA_TEXT_MAX))).toBe('x'.repeat(WA_TEXT_MAX));
  });
  it('never splits a surrogate pair', () => {
    const keep = WA_TEXT_MAX - WA_TRUNCATION_SUFFIX.length;
    const out = freeformText('a'.repeat(keep - 1) + '😀'.repeat(100));
    expect(out).toBe('a'.repeat(keep - 1) + WA_TRUNCATION_SUFFIX);
  });
});

describe('isTransientSendError', () => {
  it('retries network errors, 429, 5xx and Meta throttling codes; not other 4xx', () => {
    expect(isTransientSendError(new TypeError('Network connection lost.'))).toBe(true);
    expect(isTransientSendError(new DOMException('timed out', 'TimeoutError'))).toBe(true);
    expect(isTransientSendError(new MetaApiError(429, undefined, 'x'))).toBe(true);
    expect(isTransientSendError(new MetaApiError(500, 1, 'x'))).toBe(true);
    expect(isTransientSendError(new MetaApiError(503, undefined, 'x'))).toBe(true);
    expect(isTransientSendError(new MetaApiError(400, 130429, 'rate limit'))).toBe(true);
    expect(isTransientSendError(new MetaApiError(400, 131016, 'service unavailable'))).toBe(true);
    expect(isTransientSendError(new MetaApiError(400, 132001, 'template does not exist'))).toBe(false);
    expect(isTransientSendError(new MetaApiError(401, 190, 'token expired'))).toBe(false);
    expect(isTransientSendError(new MetaApiError(400, undefined, 'x'))).toBe(false);
  });
});

describe('sendWhatsApp (mocked Graph API)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockGraph(...responses: Response[]) {
    const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init!, body: JSON.parse(String(init!.body)) });
      const res = responses.shift();
      if (!res) throw new Error('unexpected fetch');
      return res;
    });
    return calls;
  }

  it('POSTs to the versioned messages endpoint with the bearer token', async () => {
    const calls = mockGraph(Response.json({ messages: [{ id: 'wamid.A' }] }));
    const now = Date.now();
    await expect(sendWhatsApp(cfg, 'hello', now, now - 1000)).resolves.toEqual({ waId: 'wamid.A', mode: 'freeform' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`https://graph.facebook.com/${GRAPH_API_VERSION}/555/messages`);
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe('Bearer tok');
    expect(calls[0]!.body.type).toBe('text');
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal); // AbortSignal.timeout(10 s)
  });

  it('sends a template outside the window', async () => {
    const calls = mockGraph(Response.json({ messages: [{ id: 'wamid.B' }] }));
    await expect(sendWhatsApp(cfg, 'a\nb', Date.now(), undefined)).resolves.toEqual({
      waId: 'wamid.B',
      mode: 'template',
    });
    expect(param(calls[0]!.body)).toBe('a · b');
  });

  it('throws MetaApiError with the Graph error message', async () => {
    mockGraph(Response.json({ error: { message: 'Invalid parameter', code: 100 } }, { status: 400 }));
    const err = await sendWhatsApp(cfg, 'x', Date.now(), undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect(err).toMatchObject({ status: 400, code: 100, message: 'WhatsApp send failed: Invalid parameter' });
  });

  it('falls back to the template once if Meta says the window closed (131047)', async () => {
    const calls = mockGraph(
      Response.json({ error: { message: 'Re-engagement message', code: 131047 } }, { status: 400 }),
      Response.json({ messages: [{ id: 'wamid.C' }] }),
    );
    const now = Date.now();
    await expect(sendWhatsApp(cfg, 'x', now, now - 1000)).resolves.toEqual({ waId: 'wamid.C', mode: 'template' });
    expect(calls.map((c) => c.body.type)).toEqual(['text', 'template']);
  });
});
