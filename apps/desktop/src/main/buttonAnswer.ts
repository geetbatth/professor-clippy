/**
 * A plain phone message that is one of a waiting question's buttons answers that question.
 *
 * On the phone the user often just types "Restart" instead of tapping the button or using
 * Telegram's reply (WhatsApp's quote-reply). Telegram and the WhatsApp relay ask this helper,
 * after their reply-to check and before the brain, whether the text is such an answer:
 *
 * - Only open asks count: unanswered, not dismissed (state `done`), with options, and mirrored to
 *   this channel (`tgMsgId` for Telegram, `waId` for WhatsApp), so the user has seen the buttons.
 * - The text must be a whole option: trimmed, any case, a trailing "." or "!" ignored. The answer
 *   is the option as written on the button.
 * - More than one open ask offering it is `'ambiguous'` (the channel asks the user to reply to the
 *   one they mean); none is `undefined` (the text is chat for the brain).
 *
 * Only the channels call it, for the user's own messages; the brain never goes through it.
 */
import type { Message } from '@clippy/shared';

/** The phone channels a question can be mirrored to. */
export type PhoneChannel = 'telegram' | 'whatsapp';

/** What the lookup reads of a message. */
export type ButtonAsk = Pick<Message, 'id' | 'kind' | 'state' | 'options' | 'answer' | 'tgMsgId' | 'waId'>;

export type ButtonAnswer<T extends ButtonAsk> = { ask: T; option: string } | 'ambiguous' | undefined;

/** The reply to a plain message that several open questions could take. */
export const AMBIGUOUS_ANSWER_MESSAGE = '📎 More than one question is waiting for that answer — reply to the one you mean.';

/** Trimmed, lower case, without a trailing "." or "!". */
function normalize(text: string): string {
  return text.trim().replace(/[.!]+$/, '').trim().toLowerCase();
}

/** The open ask among `asks` whose option `text` is (see the module comment). */
export function findButtonAnswer<T extends ButtonAsk>(asks: readonly T[], text: string, channel: PhoneChannel): ButtonAnswer<T> {
  const wanted = normalize(text);
  if (!wanted) return undefined;
  const matches: { ask: T; option: string }[] = [];
  for (const ask of asks) {
    if (ask.kind !== 'ask' || ask.answer !== undefined || ask.state === 'done') continue;
    if ((channel === 'telegram' ? ask.tgMsgId : ask.waId) === undefined) continue;
    const option = ask.options?.find((o) => normalize(o) === wanted);
    if (option !== undefined) matches.push({ ask, option });
  }
  if (matches.length > 1) return 'ambiguous';
  return matches[0];
}
