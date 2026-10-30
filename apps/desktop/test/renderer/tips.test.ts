import type { Message, OnboardingState } from '@clippy/shared/schemas';
import { describe, expect, it } from 'vitest';
import { aboutPage, answeredToday, nextTip, TIP_TEXT, type TipEvent } from '../../src/renderer/src/note/welcome/tips';

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 9, 30, 9);
const fresh = (over: Partial<OnboardingState> = {}): OnboardingState => ({ startedAt: T0, done: [], dismissed: false, tipsShown: [], ...over });

const QUIET: TipEvent = { kind: 'quiet-note' };
const THIRD_ANSWER: TipEvent = { kind: 'answered', answeredToday: 3, standingOrders: 0 };
const SECOND_PAGE: TipEvent = { kind: 'page-created', userPages: 2 };
const TELL: TipEvent = { kind: 'tell', text: 'remind me at 3 to call Dave' };

const tip = (event: TipEvent, state = fresh(), now = T0 + DAY) => nextTip({ now, state, showTips: true, event });

describe('nextTip', () => {
  it('each trigger yields its own tip', () => {
    expect(tip(QUIET)).toBe('quiet-history');
    expect(tip(THIRD_ANSWER)).toBe('standing-order');
    expect(tip(SECOND_PAGE)).toBe('pin-out');
    expect(tip(TELL)).toBe('pad-jot');
  });

  it('gives each tip only once', () => {
    for (const [event, id] of [
      [QUIET, 'quiet-history'],
      [THIRD_ANSWER, 'standing-order'],
      [SECOND_PAGE, 'pin-out'],
      [TELL, 'pad-jot'],
    ] as const) {
      expect(tip(event, fresh({ tipsShown: [id] }))).toBeUndefined();
    }
  });

  it('gives none with showTips off', () => {
    for (const event of [QUIET, THIRD_ANSWER, SECOND_PAGE, TELL]) {
      expect(nextTip({ now: T0 + DAY, state: fresh(), showTips: false, event })).toBeUndefined();
    }
  });

  it('gives none from day 15 (14 days after the start)', () => {
    expect(tip(QUIET, fresh(), T0 + 14 * DAY - 1)).toBe('quiet-history');
    expect(tip(QUIET, fresh(), T0 + 14 * DAY)).toBeUndefined();
    expect(tip(TELL, fresh(), T0 + 15 * DAY)).toBeUndefined();
  });

  it('at most one an hour: of two triggers within the hour, only the first', () => {
    const first = tip(QUIET, fresh(), T0 + DAY);
    expect(first).toBe('quiet-history');
    const after = fresh({ tipsShown: [first!], lastTipAt: T0 + DAY });
    expect(tip(TELL, after, T0 + DAY + 59 * 60_000)).toBeUndefined();
    expect(tip(TELL, after, T0 + DAY + 60 * 60_000)).toBe('pad-jot');
  });

  it('the standing-order tip: on exactly the 3rd answer of the day, and only without standing orders', () => {
    expect(tip({ kind: 'answered', answeredToday: 2, standingOrders: 0 })).toBeUndefined();
    expect(tip({ kind: 'answered', answeredToday: 4, standingOrders: 0 })).toBeUndefined();
    expect(tip({ kind: 'answered', answeredToday: 3, standingOrders: 1 })).toBeUndefined();
  });

  it('the pin-out tip: from the 2nd page the user makes, unless they have pinned one out already', () => {
    expect(tip({ kind: 'page-created', userPages: 1 })).toBeUndefined();
    expect(tip({ kind: 'page-created', userPages: 3 })).toBe('pin-out');
    expect(tip(SECOND_PAGE, fresh({ done: ['popout'] }))).toBeUndefined();
  });

  it('the pad-jot tip: only for a Tell box line that is not about a page', () => {
    expect(tip({ kind: 'tell', text: 'jot down: buy milk' })).toBeUndefined();
    expect(tip({ kind: 'tell', text: 'add eggs to my shopping page' })).toBeUndefined();
    expect(aboutPage('Write down the wifi password')).toBe(true);
    expect(aboutPage('what is on my Pad?')).toBe(true);
    expect(aboutPage('remind me at 3 to call Dave')).toBe(false);
    expect(aboutPage('paddle board tomorrow')).toBe(false);
  });

  it('says the approved lines', () => {
    expect(TIP_TEXT).toEqual({
      'quiet-history': "Finished pings go quietly into Settings → History while you're at your desk.",
      'standing-order': "That's three questions today. Tell me 'whenever an agent asks about X, say Y' and I'll answer those myself.",
      'pin-out': 'Pin a page out and it floats on your desktop, like a Notepad window that never needs cleaning up.',
      'pad-jot': "You can also say 'jot down: …' and I'll keep it on your Pad.",
    });
  });
});

describe('answeredToday', () => {
  const ask = (over: Partial<Message>): Message => ({
    id: '01JB2Z3K4M5N6P7Q8R9S0T1V2A',
    kind: 'ask',
    body: 'Which branch?',
    sender: 'claude-code',
    urgent: false,
    state: 'done',
    createdAt: 0,
    ...over,
  });

  it("counts the questions the user answered since local midnight, not Clippy's answers or dismissals", () => {
    const now = new Date(2026, 9, 30, 15, 0).getTime();
    const today = new Date(2026, 9, 30, 9, 0).getTime();
    const yesterday = new Date(2026, 9, 29, 23, 0).getTime();
    expect(
      answeredToday(
        [
          ask({ answer: 'main', answeredVia: 'desk', doneAt: today }),
          ask({ answer: 'yes', answeredVia: 'telegram', doneAt: today }),
          ask({ answer: 'staging', answeredVia: 'clippy', doneAt: today }),
          ask({ doneAt: today }),
          ask({ answer: 'no', answeredVia: 'whatsapp', doneAt: yesterday }),
        ],
        now,
      ),
    ).toBe(2);
  });
});
