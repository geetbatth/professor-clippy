import { useEffect, useState } from 'react';
import type { ClippyWindowShell, CursorPoint } from '../../../main/window/windowApi';

/**
 * Where the mouse is, in window coordinates: from main's global cursor feed (so Clippy can
 * lean towards it anywhere on screen), and from local mouse moves (browser preview). One update per frame.
 * While `enabled` is false it doesn't listen at all (and returns null), so nothing re-renders.
 */
export function useCursor(shell: ClippyWindowShell, enabled = true): CursorPoint | null {
  const [point, setPoint] = useState<CursorPoint | null>(null);
  useEffect(() => {
    if (!enabled) {
      setPoint(null);
      return;
    }
    let pending: CursorPoint | null = null;
    let frame = 0;
    const push = (p: CursorPoint) => {
      pending = p;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          setPoint(pending);
        });
      }
    };
    const onMove = (e: MouseEvent) => push({ x: e.clientX, y: e.clientY });
    const off = shell.onCursor(push);
    window.addEventListener('mousemove', onMove);
    return () => {
      off();
      window.removeEventListener('mousemove', onMove);
      cancelAnimationFrame(frame);
    };
  }, [shell, enabled]);
  return point;
}
