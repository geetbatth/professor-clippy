import { useEffect, useRef } from 'react';

/** Collapse the note after `idleMs` without activity, while `enabled`. `lastActivityRef` holds epoch ms. */
export function useAutoCollapse(enabled: boolean, lastActivityRef: { current: number }, idleMs: number, onCollapse: () => void): void {
  const cb = useRef(onCollapse);
  cb.current = onCollapse;
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= idleMs) cb.current();
    }, 5_000);
    return () => clearInterval(id);
  }, [enabled, lastActivityRef, idleMs]);
}
