import type { Message } from '@clippy/shared';
import { describe, expect, it } from 'vitest';
import { redactToken, TelegramApi, TelegramApiError, TelegramNetworkError } from '../../src/main/telegram/api';
import {
  askKeyboard,
  cutToEscaped,
  ensureFits,
  escapeClipped,
  escapeHtml,
  fitHtml,
  formatForTelegram,
  formatMissedReminders,
  MISSED_NOTE,
  parseAskButton,
  splitForTelegram,
  TG_MAX,
  TG_MORE,
} from '../../src/main/telegram/format';

const ID = '01JBCDEFGHJKMNPQRSTVWXYZ01';
const msg = (patch: Partial<Message>): Message => ({
  id: ID,
  kind: 'note',
  body: 'body',
  sender: 'agent',
  urgent: false,
  state: 'unread',
  createdAt: 1,
  ...patch,
});

describe('escapeHtml', () => {
  it('escapes everything Telegram HTML treats specially, and nothing else', () => {
    expect(escapeHtml('<b>&"x"</b> é 🎉')).toBe('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt; é 🎉');
    expect(escapeHtml('&amp;')).toBe('&amp;amp;'); // verbatim, even text that looks escaped
  });

  it('cuts by escaped length without splitting an entity or a surrogate pair', () => {
    expect(cutToEscaped('a&b', 5)).toBe('a'); // "a&amp;" would be 6
    expect(cutToEscaped('a&b', 6)).toBe('a&');
    expect(cutToEscaped('ab🎉', 3)).toBe('ab');
    expect(cutToEscaped('ab🎉', 4)).toBe('ab🎉');
  });
});

describe('formatForTelegram', () => {
  it('lays out a note: urgent, icon, bold title, verbatim body, italic sender line', () => {
    expect(formatForTelegram(msg({ title: 'T<1>', body: 'line 1\n  line 2', project: 'p', urgent: true }))).toBe(
      '🔴 📝 <b>T&lt;1&gt;</b>\nline 1\n  line 2\n\n<i>— agent · p</i>',
    );
    expect(formatForTelegram(msg({}))).toBe('📝 body\n\n<i>— agent</i>');
  });

  it('marks reminders with ⏰ (and the missed note) and asks with ❓', () => {
    expect(formatForTelegram(msg({ kind: 'reminder', missed: true }))).toBe(`⏰ body\n\n<i>— agent</i>\n<i>${MISSED_NOTE}</i>`);
    expect(formatForTelegram(msg({ kind: 'ask', options: ['a'] }))).toMatch(/^❓ body\n\n<i>— agent<\/i>\n<i>Tap an answer/);
    expect(formatForTelegram(msg({ kind: 'ask', answer: 'a & b', answeredVia: 'whatsapp' }), { answered: true })).toBe(
      '❓ body\n\n<i>— agent</i>\n\n✅ Answered: a &amp; b <i>(on WhatsApp)</i>',
    );
  });

  it('cuts a long body to fit 4096, ending "…more on desktop", and keeps the sender line', () => {
    const out = formatForTelegram(msg({ body: '<&>'.repeat(3000), title: 'Long' }));
    expect(out.length).toBeLessThanOrEqual(TG_MAX);
    expect(out.length).toBeGreaterThan(TG_MAX - 10);
    expect(out).toMatch(new RegExp(`(&lt;|&amp;|&gt;)${TG_MORE}\\n\\n<i>— agent</i>$`));
    expect(out).not.toMatch(/&[a-z]*…/); // no entity cut in half
    const fits = msg({ body: 'x'.repeat(TG_MAX - '📝 \n\n<i>— agent</i>'.length) });
    expect(formatForTelegram(fits)).not.toContain(TG_MORE);
  });
});

describe('every part is capped', () => {
  const huge = '<&>"'.repeat(1500); // 6000 characters, 25500 escaped

  it('escapeClipped cuts by escaped length, ending with an ellipsis', () => {
    expect(escapeClipped('a&b', 10)).toBe('a&amp;b');
    expect(escapeClipped('a&b&c', 7)).toBe('a&amp;…'); // 6 escaped characters + the ellipsis
    expect(escapeClipped('a&b&c', 6)).toBe('a…'); // "&amp;" would not fit whole
    expect(escapeClipped(huge, 100).length).toBeLessThanOrEqual(100);
  });

  it('stays within 4096 whatever the title, sender, project, body and answer', () => {
    for (const kind of ['note', 'reminder', 'ask'] as const) {
      const m = msg({ kind, title: huge, body: huge, sender: huge, project: huge, urgent: true, missed: true, options: ['x'], answer: huge, answeredVia: 'whatsapp' });
      expect(formatForTelegram(m).length).toBeLessThanOrEqual(TG_MAX);
      expect(formatForTelegram(m, { answered: true }).length).toBeLessThanOrEqual(TG_MAX);
    }
    const many = Array.from({ length: 3 }, () => msg({ kind: 'reminder', missed: true, body: huge, sender: huge, project: huge }));
    expect(formatMissedReminders(many).length).toBeLessThanOrEqual(TG_MAX);
  });

  it('fitHtml falls back to the bare body when the fixed parts alone are too long', () => {
    const out = fitHtml('<b>'.padEnd(5000, 'h') + '</b>', 'the body', '', 100);
    expect(out).toBe(`the body${TG_MORE}`); // the title and footer were dropped: say so
    expect(fitHtml('x'.repeat(200), 'b'.repeat(500), '', 100)).toBe(`${'b'.repeat(100 - TG_MORE.length)}${TG_MORE}`);
  });

  it('ensureFits leaves short HTML alone, else drops the tags and cuts without breaking an entity', () => {
    expect(ensureFits('<b>hi</b>')).toBe('<b>hi</b>');
    expect(ensureFits('<b>' + 'a'.repeat(4094) + '</b>')).toBe('a'.repeat(4094));
    const cut = ensureFits('&amp;'.repeat(2000));
    expect(cut.length).toBeLessThanOrEqual(TG_MAX);
    expect(cut).toMatch(/^(&amp;)+…more on desktop$/);
  });
});

describe('formatMissedReminders', () => {
  it('combines reminders into one message', () => {
    const out = formatMissedReminders([msg({ kind: 'reminder', missed: true, body: 'one' }), msg({ kind: 'reminder', missed: true, body: 'two', urgent: true, project: 'x' })]);
    expect(out).toBe(`⏰ <b>2 reminders</b> <i>${MISSED_NOTE}</i>\n\n• one\n<i>— agent</i>\n\n🔴 • two\n<i>— agent · x</i>`);
  });

  it('drops what does not fit, saying so', () => {
    const many = Array.from({ length: 50 }, (_, i) => msg({ kind: 'reminder', missed: true, body: `${i} ${'z'.repeat(200)}` }));
    const out = formatMissedReminders(many);
    expect(out.length).toBeLessThanOrEqual(TG_MAX);
    expect(out.endsWith(`\n\n${TG_MORE}`)).toBe(true);
    const huge = formatMissedReminders([msg({ kind: 'reminder', body: 'y'.repeat(9000) }), msg({ kind: 'reminder', body: 'next' })]);
    expect(huge.length).toBeLessThanOrEqual(TG_MAX);
    expect(huge).not.toContain('next');
  });
});

describe('splitForTelegram', () => {
  it('leaves a short reply whole (escaped)', () => {
    expect(splitForTelegram('a < b')).toEqual(['a &lt; b']);
    expect(splitForTelegram('')).toEqual(['']);
  });

  it('splits at 4096 escaped characters, preferring line and word breaks', () => {
    const text = `${'alpha '.repeat(500)}\n${'beta '.repeat(500)}`; // 5501 characters, a newline at 3000
    const parts = splitForTelegram(text);
    expect(parts.length).toBe(2);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(TG_MAX);
    expect(parts[0]!.endsWith('alpha')).toBe(true);
    expect(parts[1]!.startsWith('beta')).toBe(true);
  });

  it('splits a string with no spaces, counting escapes', () => {
    const parts = splitForTelegram('&'.repeat(2000)); // 10000 escaped characters
    expect(parts.map((p) => p.length)).toEqual([4095, 4095, 1810]);
  });

  it('stops after 4 parts, the last ending "…more on desktop"', () => {
    const parts = splitForTelegram('x'.repeat(TG_MAX * 6));
    expect(parts).toHaveLength(4);
    expect(parts[3]!.endsWith(TG_MORE)).toBe(true);
    expect(parts[3]!.length).toBe(TG_MAX);
  });
});

describe('ask buttons', () => {
  it('round-trips callback data and caps the buttons', () => {
    const kb = askKeyboard(msg({ kind: 'ask', options: Array.from({ length: 12 }, (_, i) => `o${i}`) }))!;
    expect(kb.inline_keyboard).toHaveLength(10);
    const data = kb.inline_keyboard[3]![0]!.callback_data;
    expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
    expect(parseAskButton(data)).toEqual({ askId: ID, index: 3 });
    expect(parseAskButton('a:nope:1')).toBeUndefined();
    expect(parseAskButton(undefined)).toBeUndefined();
    expect(askKeyboard(msg({ kind: 'ask' }))).toBeUndefined();
  });
});

describe('TelegramApi errors', () => {
  const token = '123456789:AAHsecretsecretsecretsecretsecret';

  it('redacts the token from anything', () => {
    expect(redactToken(`GET https://api.telegram.org/bot${token}/getUpdates?offset=1 failed`, token)).toBe(
      'GET https://api.telegram.org/bot<token>/getUpdates?offset=1 failed',
    );
    expect(redactToken(`token ${token} leaked`)).toBe('token <token> leaked');
  });

  it('turns a network failure into an error without the URL or token', async () => {
    const api = new TelegramApi({
      token,
      fetch: async (url) => {
        throw new TypeError(`fetch failed`, { cause: new Error(`connect ECONNREFUSED for ${String(url)}`) });
      },
    });
    const err = await api.sendMessage({ chat_id: 1, text: 'x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TelegramNetworkError);
    expect(String((err as Error).message)).not.toContain('AAHsecret');
    expect(String((err as Error).message)).toContain('/bot<token>/sendMessage');
  });

  it('reads Telegram errors, including 429 retry_after', async () => {
    const api = new TelegramApi({
      token,
      fetch: async () =>
        new Response(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 7', parameters: { retry_after: 7 } }), {
          status: 429,
        }),
    });
    const err = (await api.getMe().catch((e: unknown) => e)) as TelegramApiError;
    expect(err).toBeInstanceOf(TelegramApiError);
    expect(err).toMatchObject({ status: 429, retryAfterS: 7, permanent: false });
    expect(new TelegramApiError('x', 403, 'Forbidden').permanent).toBe(true);
  });
});
