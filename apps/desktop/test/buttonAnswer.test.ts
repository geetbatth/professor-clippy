import { describe, expect, it } from 'vitest';
import { findButtonAnswer, type ButtonAsk } from '../src/main/buttonAnswer';

/** An open ask with Restart / Cancel that went to Telegram (message 7) and WhatsApp. */
const ask = (over: Partial<ButtonAsk> = {}): ButtonAsk => ({
  id: 'a1',
  kind: 'ask',
  state: 'unread',
  options: ['Restart', 'Cancel'],
  tgMsgId: 7,
  waId: 'wamid.7',
  ...over,
});

describe('findButtonAnswer', () => {
  it('matches an option trimmed, in any case, ignoring a trailing . or !, and answers with its own casing', () => {
    const a = ask();
    for (const text of ['Restart', 'restart', '  RESTART ', 'restart.', 'Restart!', 'restart !']) {
      expect(findButtonAnswer([a], text, 'telegram'), text).toEqual({ ask: a, option: 'Restart' });
    }
    expect(findButtonAnswer([a], 'cancel', 'whatsapp')).toEqual({ ask: a, option: 'Cancel' });
  });

  it('needs the whole option: other text (yes please, restart it, a word inside) matches nothing', () => {
    for (const text of ['yes please', 'restart it', 'Restart now?', 'start', 'Restart?', '', '!']) {
      expect(findButtonAnswer([ask()], text, 'telegram'), text).toBeUndefined();
    }
  });

  it('only counts asks mirrored to this channel', () => {
    const tgOnly = ask({ waId: undefined });
    const waOnly = ask({ tgMsgId: undefined });
    expect(findButtonAnswer([tgOnly], 'restart', 'whatsapp')).toBeUndefined();
    expect(findButtonAnswer([tgOnly], 'restart', 'telegram')).toEqual({ ask: tgOnly, option: 'Restart' });
    expect(findButtonAnswer([waOnly], 'restart', 'telegram')).toBeUndefined();
    expect(findButtonAnswer([waOnly], 'restart', 'whatsapp')).toEqual({ ask: waOnly, option: 'Restart' });
  });

  it('ignores answered, dismissed and option-less asks, and anything that is not an ask', () => {
    expect(findButtonAnswer([ask({ answer: 'Cancel' })], 'restart', 'telegram')).toBeUndefined();
    expect(findButtonAnswer([ask({ state: 'done' })], 'restart', 'telegram')).toBeUndefined();
    expect(findButtonAnswer([ask({ options: undefined })], 'restart', 'telegram')).toBeUndefined();
    expect(findButtonAnswer([ask({ options: [] })], 'restart', 'telegram')).toBeUndefined();
    expect(findButtonAnswer([ask({ kind: 'note' })], 'restart', 'telegram')).toBeUndefined();
  });

  it('a snoozed ask still counts (its question is still waiting on the phone)', () => {
    const a = ask({ state: 'snoozed' });
    expect(findButtonAnswer([a], 'restart', 'telegram')).toEqual({ ask: a, option: 'Restart' });
  });

  it('is ambiguous when two open asks offer the answer, and picks the one that does when only one does', () => {
    const restart = ask({ id: 'a1' });
    const approval = ask({ id: 'a2', options: ['Allow', 'Deny', 'Cancel'] });
    expect(findButtonAnswer([restart, approval], 'cancel', 'telegram')).toBe('ambiguous');
    expect(findButtonAnswer([restart, approval], 'allow', 'telegram')).toEqual({ ask: approval, option: 'Allow' });
    // The other one was answered meanwhile: no longer ambiguous.
    expect(findButtonAnswer([restart, { ...approval, answer: 'Deny' }], 'cancel', 'telegram')).toEqual({ ask: restart, option: 'Cancel' });
  });

  it('one ask offering the same option twice is still one match (the first spelling)', () => {
    const a = ask({ options: ['OK', 'ok'] });
    expect(findButtonAnswer([a], 'Ok', 'telegram')).toEqual({ ask: a, option: 'OK' });
  });
});
