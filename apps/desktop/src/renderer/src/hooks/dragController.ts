/**
 * Window dragging by a handle, without React, so the edge cases are testable.
 *
 * Main moves the window to follow the cursor between `dragStart` and `dragEnd`, so a drag
 * that never ends leaves Clippy glued to the cursor. The usual end is the handle's own
 * `pointerup`. But the handle can be unmounted mid-drag (a new message switches mini Clippy
 * to the note, which remounts him elsewhere): the browser then fires `lostpointercapture`
 * at the document, not at the handle, and the release lands on whatever is under the cursor.
 * So while a drag is live we also listen on the document, and only the handle that started
 * the drag can turn a release into a click.
 */
import type { ClippyWindowShell } from '../../../main/window/windowApi';

/** Moves smaller than this (px) count as a click, not a drag. */
export const CLICK_SLOP = 4;

/** What we need of the element the drag started on (an `Element`). */
export interface DragTarget {
  setPointerCapture(pointerId: number): void;
  releasePointerCapture(pointerId: number): void;
  hasPointerCapture(pointerId: number): boolean;
}

/** The fields we read from a pointer event (React's or the DOM's). */
export interface DragPointerEvent {
  pointerId: number;
  screenX: number;
  screenY: number;
  button: number;
  currentTarget: unknown;
}

export interface DragControllerOptions {
  shell: Pick<ClippyWindowShell, 'dragStart' | 'dragMove' | 'dragEnd'>;
  /** Set while a drag is live (several handles can share one). */
  dragging: { current: boolean };
  /** Read at release time: called when the press barely moved. */
  onClick?: () => (() => void) | undefined;
  /** Where releases are watched while a drag is live; the page's `document`. */
  doc: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

export interface DragController {
  down(e: DragPointerEvent): void;
  move(e: DragPointerEvent): void;
  /** `pointerup` on a handle. */
  up(e: DragPointerEvent): void;
  /** `pointercancel` / `lostpointercapture` on a handle. */
  cancel(e: DragPointerEvent): void;
  /** True while a drag (or a press that may become a click) is live. */
  readonly active: boolean;
}

const DOC_EVENTS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;

export function createDragController({ shell, dragging, onClick, doc }: DragControllerOptions): DragController {
  let live: { x: number; y: number; moved: boolean; pointerId: number; target: DragTarget } | null = null;

  // Reaches the document only if no handle finished the drag first (handlers run on the way up).
  const onDocument = (e: Event) => {
    if (live && (e as unknown as { pointerId?: number }).pointerId === live.pointerId) finish(false);
  };

  function finish(click: boolean): void {
    const s = live;
    if (!s) return;
    live = null;
    for (const type of DOC_EVENTS) doc.removeEventListener(type, onDocument);
    dragging.current = false;
    try {
      if (s.target.hasPointerCapture(s.pointerId)) s.target.releasePointerCapture(s.pointerId);
    } catch {
      // The handle is gone; so is its capture.
    }
    shell.dragEnd();
    if (click && !s.moved) onClick?.()?.();
  }

  return {
    down(e) {
      if (e.button !== 0) return;
      finish(false); // a stray earlier press never outlives a new one
      const target = e.currentTarget as DragTarget;
      target.setPointerCapture(e.pointerId);
      live = { x: e.screenX, y: e.screenY, moved: false, pointerId: e.pointerId, target };
      for (const type of DOC_EVENTS) doc.addEventListener(type, onDocument);
      dragging.current = true;
      shell.dragStart();
    },
    move(e) {
      const s = live;
      if (!s || e.pointerId !== s.pointerId) return;
      if (!s.moved && Math.hypot(e.screenX - s.x, e.screenY - s.y) < CLICK_SLOP) return;
      s.moved = true;
      shell.dragMove();
    },
    up(e) {
      if (!live || e.pointerId !== live.pointerId) return;
      // Released on another element (the handle was remounted): end the drag, but no click.
      finish(e.currentTarget === live.target);
    },
    cancel(e) {
      if (live && e.pointerId === live.pointerId) finish(false);
    },
    get active() {
      return live !== null;
    },
  };
}
