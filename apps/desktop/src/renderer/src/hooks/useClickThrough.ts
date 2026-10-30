import { useEffect, type RefObject } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';

/** Elements (or their ancestors) marked `data-solid` catch the mouse; everything else clicks through. */
export function isSolid(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-solid]') !== null;
}

/**
 * Click-through for the transparent window: main starts it ignoring the mouse (with
 * moves forwarded), and this flips capture on while the pointer is over an opaque part.
 * Never flips during a drag (`holdRef.current`), or the drag would lose the mouse.
 */
export function useClickThrough(shell: ClippyWindowShell, holdRef: RefObject<boolean>, onSolidEnter: () => void): void {
  useEffect(() => {
    let capturing = false;
    const set = (solid: boolean) => {
      if (solid === capturing || holdRef.current) return;
      capturing = solid;
      shell.setIgnoreMouse(!solid);
      if (solid) onSolidEnter();
    };
    const onMove = (e: MouseEvent) => set(isSolid(e.target));
    const onLeave = () => set(false);
    window.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [shell, holdRef, onSolidEnter]);
}
