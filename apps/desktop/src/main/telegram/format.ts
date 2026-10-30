/**
 * Telegram text for mirrored messages: HTML (`parse_mode: 'HTML'`) with everything from an
 * agent escaped, so a body is shown verbatim and can never inject markup.
 *
 * Layout: an optional 🔴 (urgent), the kind's icon (📝 note, ⏰ reminder, ❓ ask), a bold
 * title if any, the body, then a small italic "— sender · project" line. Telegram allows
 * {@link TG_MAX} characters per message; longer text is cut (mirrors) or split (chat
 * replies), ending "…more on desktop". Lengths are measured on the HTML, which is never
 * shorter than the text Telegram counts, so the result always fits.
 */
import type { AnsweredVia, Message } from '@clippy/shared';
import type { InlineKeyboardButton } from './api';

/** Telegram's limit for one message's text. */
export const TG_MAX = 4096;
/** Ends text that had to be cut. */
export const TG_MORE = '…more on desktop';
/** Marks a reminder that fired while the PC was off or asleep. */
export const MISSED_NOTE = '(missed while your PC was off)';
/** Most option buttons shown under an ask. */
export const MAX_BUTTONS = 10;
/** A long chat reply goes out as at most this many messages. */
export const MAX_REPLY_PARTS = 4;
/**
 * Caps (escaped characters) for every part around the body, so that however long an agent's
 * title, sender, project or answer is, they leave room for the body and the whole message
 * fits in {@link TG_MAX}.
 */
export const TITLE_MAX = 512;
export const NAME_MAX = 120;
export const ANSWER_MAX = 1000;

/** Escape text for Telegram's HTML parse mode (`&`, `<`, `>`; `"` too, harmlessly). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const escapedLength = (ch: string): number =>
  ch === '&' ? 5 : ch === '<' || ch === '>' ? 4 : ch === '"' ? 6 : ch.length;

/**
 * The longest prefix of `text` whose escaped form is at most `budget` characters, never
 * splitting a surrogate pair.
 */
export function cutToEscaped(text: string, budget: number): string {
  let used = 0;
  let end = 0;
  for (const ch of text) {
    const len = escapedLength(ch);
    if (used + len > budget) break;
    used += len;
    end += ch.length;
  }
  return text.slice(0, end);
}

/** `text` escaped, cut (ending "…") so that the escaped form is at most `budget` characters. */
export function escapeClipped(text: string, budget: number): string {
  const escaped = escapeHtml(text);
  if (escaped.length <= budget) return escaped;
  return `${escapeHtml(cutToEscaped(text, Math.max(0, budget - 1)).trimEnd())}…`;
}

/**
 * `head` + escaped `body` + `tail`, with `body` cut (ending {@link TG_MORE}) to fit in `max`.
 * If `head` and `tail` alone don't fit (the capped parts never get there; a guard), it falls
 * back to the body alone, cut, without markup.
 */
export function fitHtml(head: string, body: string, tail: string, max = TG_MAX): string {
  const whole = head + escapeHtml(body) + tail;
  if (whole.length <= max) return whole;
  const budget = max - head.length - tail.length - TG_MORE.length;
  if (budget < 0) return escapeHtml(cutToEscaped(body, Math.max(0, max - TG_MORE.length)).trimEnd()) + TG_MORE;
  return head + escapeHtml(cutToEscaped(body, budget).trimEnd()) + TG_MORE + tail;
}

/**
 * Last line of defence before a send: HTML at most `max` characters. Anything longer loses its
 * tags (entities are kept whole) and is cut, ending {@link TG_MORE}, rather than being refused
 * by Telegram with a 400 and never delivered.
 */
export function ensureFits(html: string, max = TG_MAX): string {
  if (html.length <= max) return html;
  const plain = html.replace(/<[^>]*>/g, '');
  if (plain.length <= max) return plain;
  let cut = plain.slice(0, max - TG_MORE.length);
  const amp = cut.lastIndexOf('&');
  if (amp > cut.lastIndexOf(';')) cut = cut.slice(0, amp); // don't leave half an entity
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // nor half a surrogate pair
  return cut.trimEnd() + TG_MORE;
}

/** The small italic "— sender · project" line. */
export function footerHtml(m: Pick<Message, 'sender' | 'project'>): string {
  return `<i>— ${escapeClipped(m.sender, NAME_MAX)}${m.project ? ` · ${escapeClipped(m.project, NAME_MAX)}` : ''}</i>`;
}

function icon(m: Message): string {
  return m.kind === 'ask' ? '❓' : m.kind === 'reminder' ? '⏰' : '📝';
}

const VIA_LABEL: Record<AnsweredVia, string> = {
  telegram: '',
  desk: 'on the desk',
  whatsapp: 'on WhatsApp',
  clippy: 'by Clippy',
};

/** The line an answered ask's Telegram copy gets: "✅ Answered: …". */
export function answeredLine(m: Pick<Message, 'answer' | 'answeredVia'>): string {
  const via = m.answeredVia ? VIA_LABEL[m.answeredVia] : '';
  return `✅ Answered: ${escapeClipped(m.answer ?? '', ANSWER_MAX)}${via ? ` <i>(${via})</i>` : ''}`;
}

/**
 * The Telegram HTML for a note, fired reminder or ask. With `answered`, an ask's copy as it
 * is edited once answered (no "tap an answer" hint, plus the {@link answeredLine}).
 */
export function formatForTelegram(m: Message, options: { answered?: boolean } = {}): string {
  let head = `${m.urgent ? '🔴 ' : ''}${icon(m)} `;
  if (m.title) head += `<b>${escapeClipped(m.title, TITLE_MAX)}</b>\n`;
  let tail = `\n\n${footerHtml(m)}`;
  if (m.kind === 'reminder' && m.missed) tail += `\n<i>${MISSED_NOTE}</i>`;
  if (m.kind === 'ask') {
    if (options.answered) tail += `\n\n${answeredLine(m)}`;
    else tail += m.options?.length ? '\n<i>Tap an answer, or reply to this message with your own.</i>' : '\n<i>Reply to this message to answer.</i>';
  }
  return fitHtml(head, m.body, tail);
}

/**
 * One Telegram message for reminders that fired together while the PC was off (the catch-up
 * on start or wake). A single reminder is formatted as usual (with the missed note).
 */
export function formatMissedReminders(ms: readonly Message[], max = TG_MAX): string {
  if (ms.length === 1) return formatForTelegram(ms[0]!);
  const head = `⏰ <b>${ms.length} reminders</b> <i>${MISSED_NOTE}</i>`;
  const more = `\n\n${TG_MORE}`;
  let out = head;
  for (const [i, m] of ms.entries()) {
    const itemHead = `\n\n${m.urgent ? '🔴 ' : ''}• `;
    const itemTail = `\n${footerHtml(m)}`;
    const item = itemHead + escapeHtml(m.body) + itemTail;
    const reserve = i === ms.length - 1 ? 0 : more.length;
    if (out.length + item.length + reserve <= max) {
      out += item;
      continue;
    }
    // The first item alone is too long: cut its body. Otherwise stop here.
    if (i === 0) out += fitHtml(itemHead, m.body, itemTail, max - out.length - more.length);
    return out + more;
  }
  return out;
}

/**
 * Split a plain-text chat reply into Telegram messages (escaped HTML, each at most `max`),
 * breaking at a newline or space where it can. More than {@link MAX_REPLY_PARTS} parts: the
 * last is cut, ending {@link TG_MORE}.
 */
export function splitForTelegram(text: string, max = TG_MAX, maxParts = MAX_REPLY_PARTS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (escapeHtml(rest).length <= max) {
      parts.push(escapeHtml(rest));
      break;
    }
    if (parts.length === maxParts - 1) {
      parts.push(escapeHtml(cutToEscaped(rest, max - TG_MORE.length).trimEnd()) + TG_MORE);
      break;
    }
    let chunk = cutToEscaped(rest, max);
    // Prefer a line break in the second half of the window, then a space.
    const line = chunk.lastIndexOf('\n');
    const brk = line > chunk.length / 2 ? line : chunk.lastIndexOf(' ');
    if (brk > chunk.length / 2) chunk = chunk.slice(0, brk + 1);
    parts.push(escapeHtml(chunk.trimEnd()));
    rest = rest.slice(chunk.length).replace(/^\s+/, '');
  }
  return parts.length ? parts : [''];
}

/** Callback data for an ask's option button: `a:<ask id>:<option index>` (well under 64 bytes). */
export function askButtonData(askId: string, index: number): string {
  return `a:${askId}:${index}`;
}

/** The ask id and option index from a button's callback data, or undefined. */
export function parseAskButton(data: string | undefined): { askId: string; index: number } | undefined {
  const m = data === undefined ? null : /^a:([0-9A-Z]{26}):(\d{1,2})$/.exec(data);
  return m ? { askId: m[1]!, index: Number(m[2]) } : undefined;
}

/** One button per option, one per row. */
export function askKeyboard(m: Message): { inline_keyboard: InlineKeyboardButton[][] } | undefined {
  const options = m.options?.slice(0, MAX_BUTTONS) ?? [];
  if (!options.length) return undefined;
  return { inline_keyboard: options.map((text, i) => [{ text, callback_data: askButtonData(m.id, i) }]) };
}
