import { useEffect, type RefObject } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';
import { createClickThrough } from './clickThrough';

export { setHitTest, type HitTest } from './clickThrough';

/** Window event asking click-through to look again at the last cursor position. */
const RECHECK_EVENT = 'clippy:hit-recheck';

/** What's solid changed under a still cursor (a new pose, a new mode): look again. */
export function requestHitRecheck(): void {
  window.dispatchEvent(new Event(RECHECK_EVENT));
}

/**
 * Click-through for the transparent window: main starts it ignoring the mouse (with
 * moves forwarded), and this flips capture on while the pointer is over an opaque part.
 * Never flips during a drag (`holdRef.current`), or the drag would lose the mouse.
 * Also looks again when the window resizes or a `requestHitRecheck()` says the layout changed.
 */
export function useClickThrough(shell: ClippyWindowShell, holdRef: RefObject<boolean>, onSolidEnter: () => void): void {
  useEffect(() => {
    const ct = createClickThrough({
      setIgnoreMouse: (ignore) => shell.setIgnoreMouse(ignore),
      hold: () => holdRef.current,
      onSolidEnter,
      elementFromPoint: (x, y) => document.elementFromPoint(x, y),
    });
    const onMove = (e: MouseEvent) => ct.move(e.clientX, e.clientY);
    const onLeave = () => ct.leave();
    const onRecheck = () => ct.recheck();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('resize', onRecheck);
    window.addEventListener(RECHECK_EVENT, onRecheck);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('resize', onRecheck);
      window.removeEventListener(RECHECK_EVENT, onRecheck);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [shell, holdRef, onSolidEnter]);
}
