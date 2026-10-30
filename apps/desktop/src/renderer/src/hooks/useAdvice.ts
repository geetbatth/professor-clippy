import { useEffect, useRef } from 'react';
import { nextAdviceDelay } from '../quips/pickQuip';

/** While `enabled`, calls `onAdvice` at random 30–90 minute intervals (unsolicited advice). */
export function useAdvice(enabled: boolean, onAdvice: () => void): void {
  const cb = useRef(onAdvice);
  cb.current = onAdvice;
  useEffect(() => {
    if (!enabled) return;
    let id: ReturnType<typeof setTimeout>;
    const schedule = () => {
      id = setTimeout(() => {
        cb.current();
        schedule();
      }, nextAdviceDelay());
    };
    schedule();
    return () => clearTimeout(id);
  }, [enabled]);
}
