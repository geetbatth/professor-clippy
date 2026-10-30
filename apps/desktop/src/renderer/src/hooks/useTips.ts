import { useCallback, useEffect, useRef } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { OnboardingState, TipId } from '@clippy/shared/schemas';
import { answeredByUser, answeredToday, nextTip, TIP_PERIOD_MS, TIP_TEXT, type TipEvent } from '../note/welcome/tips';

export interface TipsOptions {
  api: ClippyWindowApi;
  onboarding: OnboardingState | undefined;
  /** Settings → Look → Show tips. */
  showTips: boolean;
  /** The bubble is free and in view now (note open, no quip up, not in the welcome). */
  canShow(): boolean;
  show(text: string): void;
}

/**
 * Clippy's one-time tips. Watches for the moments `nextTip` cares about that arrive as events (an
 * agent's finished note filed quietly, a question the user answered) and returns `tip(event)` for
 * the ones App sees itself (a page made, a Tell box line). A tip that comes up while the bubble is
 * busy (a quip) or out of sight is skipped without being recorded, so a later moment can say it.
 */
export function useTips({ api, onboarding, showTips, canShow, show }: TipsOptions): (event: TipEvent) => void {
  const state = useRef(onboarding);
  state.current = onboarding;
  const live = useRef({ showTips, canShow, show });
  live.current = { showTips, canShow, show };
  /** Tips shown from here, counted at once (before `onboarding:changed` brings them back from main). */
  const shown = useRef<{ ids: TipId[]; at?: number }>({ ids: [] });

  const tip = useCallback(
    (event: TipEvent) => {
      const saved = state.current;
      if (!saved) return;
      const mine = shown.current;
      const current: OnboardingState = {
        ...saved,
        tipsShown: [...saved.tipsShown, ...mine.ids],
        ...(mine.at !== undefined && { lastTipAt: Math.max(mine.at, saved.lastTipAt ?? 0) }),
      };
      const now = Date.now();
      const id = nextTip({ now, state: current, showTips: live.current.showTips, event });
      if (!id || !live.current.canShow()) return;
      live.current.show(TIP_TEXT[id]);
      shown.current = { ids: [...mine.ids, id], at: now };
      api.markTipShown(id).catch(() => {});
    },
    [api],
  );

  useEffect(() => {
    /** Answers already counted (an answered ask can be updated again, e.g. its phone copy). */
    const counted = new Set<string>();
    const offNew = api.on('message:new', (m) => {
      if (m.kind === 'note' && m.event === 'agent-finished' && m.state === 'done') tip({ kind: 'quiet-note' });
    });
    const offUpdated = api.on('message:updated', (m) => {
      if (!answeredByUser(m) || counted.has(m.id)) return;
      counted.add(m.id);
      // Only worth the lookups while the tip can still come.
      const saved = state.current;
      if (!saved || !live.current.showTips || saved.tipsShown.includes('standing-order') || Date.now() - saved.startedAt >= TIP_PERIOD_MS) return;
      void Promise.all([api.listMessages({ kind: 'ask', state: 'done' }), api.listOrders()]).then(
        ([asks, orders]) => tip({ kind: 'answered', answeredToday: answeredToday(asks, Date.now()), standingOrders: orders.length }),
        () => {},
      );
    });
    return () => {
      offNew();
      offUpdated();
    };
  }, [api, tip]);

  return tip;
}
