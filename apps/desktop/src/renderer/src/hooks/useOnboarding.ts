import { useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { OnboardingState } from '@clippy/shared/schemas';

/** The Getting started list and the tips given so far, kept live from `onboarding:changed`. Undefined until loaded. */
export function useOnboarding(api: ClippyWindowApi): OnboardingState | undefined {
  const [state, setState] = useState<OnboardingState>();
  useEffect(() => {
    let live = true;
    void api.onboarding().then((s) => live && setState(s), () => {});
    const off = api.on('onboarding:changed', setState);
    return () => {
      live = false;
      off();
    };
  }, [api]);
  return state;
}
