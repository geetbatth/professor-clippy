import { useMemo, useRef, type PointerEvent, type RefObject } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';
import { createDragController } from './dragController';

export interface DragHandle {
  onPointerDown(e: PointerEvent<Element>): void;
  onPointerMove(e: PointerEvent<Element>): void;
  onPointerUp(e: PointerEvent<Element>): void;
  onPointerCancel(e: PointerEvent<Element>): void;
  onLostPointerCapture(e: PointerEvent<Element>): void;
}

/**
 * Drag the frameless window by a handle: main follows the cursor between dragStart and dragEnd.
 * A press that barely moves calls `onClick` instead. Sets the shared `draggingRef` mid-drag
 * (several handles can share one, so click-through stays put whichever is dragged).
 * A cancelled pointer, lost capture, or the handle being remounted mid-drag ends the drag
 * (never a click), so it can't get stuck; see `dragController.ts`.
 */
export function useWindowDrag(shell: ClippyWindowShell, draggingRef: RefObject<boolean>, onClick?: () => void): DragHandle {
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;

  return useMemo<DragHandle>(() => {
    const drag = createDragController({ shell, dragging: draggingRef, onClick: () => onClickRef.current, doc: document });
    return {
      onPointerDown: (e) => drag.down(e),
      onPointerMove: (e) => drag.move(e),
      onPointerUp: (e) => drag.up(e),
      onPointerCancel: (e) => drag.cancel(e),
      onLostPointerCapture: (e) => drag.cancel(e),
    };
  }, [shell, draggingRef]);
}
