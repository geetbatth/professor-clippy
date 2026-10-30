import { useEffect, useState } from 'react';
import type { ClippyWindowShell, CursorPoint } from '../../../main/window/windowApi';

/**
 * Where the mouse is, in window coordinates: from main's global cursor feed (so Clippy can
 * lean towards it anywhere on screen), and from local mouse moves (browser preview). One update per frame.
 */
export function useCursor(shell: ClippyWindowShell): CursorPoint | null {
  const [point, setPoint] = useState<CursorPoint | null>(null);
  useEffect(() => {
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
  }, [shell]);
  return point;
}
