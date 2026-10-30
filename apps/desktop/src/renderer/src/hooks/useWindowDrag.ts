import { useMemo, useRef, type PointerEvent, type RefObject } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';

/** Moves smaller than this (px) count as a click, not a drag. */
const CLICK_SLOP = 4;

export interface DragHandle {
  onPointerDown(e: PointerEvent<Element>): void;
  onPointerMove(e: PointerEvent<Element>): void;
  onPointerUp(e: PointerEvent<Element>): void;
}

/**
 * Drag the frameless window by a handle: main follows the cursor between dragStart and dragEnd.
 * A press that barely moves calls `onClick` instead. Sets the shared `draggingRef` mid-drag
 * (several handles can share one, so click-through stays put whichever is dragged).
 */
export function useWindowDrag(shell: ClippyWindowShell, draggingRef: RefObject<boolean>, onClick?: () => void): DragHandle {
  const start = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  const handle = useMemo<DragHandle>(
    () => ({
      onPointerDown(e) {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.screenX, y: e.screenY, moved: false };
        draggingRef.current = true;
        shell.dragStart();
      },
      onPointerMove(e) {
        const s = start.current;
        if (!s) return;
        if (!s.moved && Math.hypot(e.screenX - s.x, e.screenY - s.y) < CLICK_SLOP) return;
        s.moved = true;
        shell.dragMove();
      },
      onPointerUp(e) {
        const s = start.current;
        if (!s) return;
        start.current = null;
        draggingRef.current = false;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        shell.dragEnd();
        if (!s.moved) onClickRef.current?.();
      },
    }),
    [shell, draggingRef],
  );
  return handle;
}
