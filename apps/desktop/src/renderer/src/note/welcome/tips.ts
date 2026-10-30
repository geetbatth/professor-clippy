/**
 * Clippy's one-time tips (pure): which tip, if any, a moment in the app calls for. A tip is said
 * once, only in the first 14 days after this version first ran, at most one an hour, and never
 * with Settings → Look → Show tips off. App shows it in the speech bubble and records it
 * (`markTipShown`).
 */
import type { Message, OnboardingState, TipId } from '@clippy/shared/schemas';

/** Tips stop this long after `startedAt`. */
export const TIP_PERIOD_MS = 14 * 24 * 60 * 60_000;
/** At most one tip in this long. */
export const TIP_GAP_MS = 60 * 60_000;
/** How long a tip stays in the speech bubble. */
export const TIP_SHOW_MS = 12_000;

/** What just happened that a tip might be about. */
export type TipEvent =
  /** An agent's "finished" note was filed straight into History (the user is at the PC). */
  | { kind: 'quiet-note' }
  /** The user answered a question; how many they have answered today, and their standing orders. */
  | { kind: 'answered'; answeredToday: number; standingOrders: number }
  /** The user made a page; how many they have made (archived ones too). */
  | { kind: 'page-created'; userPages: number }
  /** A line sent from the Tell Clippy box. */
  | { kind: 'tell'; text: string };

export const TIP_TEXT: Record<TipId, string> = {
  'quiet-history': "Finished pings go quietly into Settings → History while you're at your desk.",
  'standing-order': "That's three questions today. Tell me 'whenever an agent asks about X, say Y' and I'll answer those myself.",
  'pin-out': 'Pin a page out and it floats on your desktop, like a Notepad window that never needs cleaning up.',
  'pad-jot': "You can also say 'jot down: …' and I'll keep it on your Pad.",
};

/** Is a Tell box line about the Pad already ("jot down", "add X to my Y page", "what's on my pad")? */
export function aboutPage(text: string): boolean {
  return /\b(jot|pages?|pad|notepad|(note|write) (it )?down)\b/i.test(text);
}

/** Did the user (not a standing order) answer this question? */
export const answeredByUser = (m: Pick<Message, 'kind' | 'answer' | 'answeredVia'>): boolean =>
  m.kind === 'ask' && m.answer !== undefined && m.answeredVia !== undefined && m.answeredVia !== 'clippy';

/** How many questions the user has answered since local midnight. */
export function answeredToday(asks: readonly Message[], now: number): number {
  const midnight = new Date(now).setHours(0, 0, 0, 0);
  return asks.filter((m) => answeredByUser(m) && (m.doneAt ?? m.createdAt) >= midnight).length;
}

/** The tip `event` calls for, before the once / two-weeks / hourly rules. */
function trigger(event: TipEvent, state: OnboardingState): TipId | undefined {
  switch (event.kind) {
    case 'quiet-note':
      return 'quiet-history';
    case 'answered':
      // "That's three questions today": exactly the third, so the line stays true.
      return event.answeredToday === 3 && event.standingOrders === 0 ? 'standing-order' : undefined;
    case 'page-created':
      // Nothing to point out to someone who has already pinned a page out.
      return event.userPages >= 2 && !state.done.includes('popout') ? 'pin-out' : undefined;
    case 'tell':
      return aboutPage(event.text) ? undefined : 'pad-jot';
  }
}

export function nextTip(ctx: { now: number; state: OnboardingState; showTips: boolean; event: TipEvent }): TipId | undefined {
  const { now, state, showTips, event } = ctx;
  if (!showTips) return undefined;
  if (now - state.startedAt >= TIP_PERIOD_MS) return undefined;
  if (state.lastTipAt !== undefined && now - state.lastTipAt < TIP_GAP_MS) return undefined;
  const id = trigger(event, state);
  return id === undefined || state.tipsShown.includes(id) ? undefined : id;
}
