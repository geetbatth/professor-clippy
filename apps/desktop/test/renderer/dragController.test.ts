import { describe, expect, it } from 'vitest';
import { createDragController, type DragPointerEvent, type DragTarget } from '../../src/renderer/src/hooks/dragController';

/** A handle element with pointer capture, like the DOM's. */
class Handle implements DragTarget {
  captured = new Set<number>();
  connected = true;
  setPointerCapture(id: number) {
    this.captured.add(id);
  }
  releasePointerCapture(id: number) {
    if (!this.connected) throw new Error('NotFoundError: not connected');
    this.captured.delete(id);
  }
  hasPointerCapture(id: number) {
    return this.connected && this.captured.has(id);
  }
}

function setup() {
  const calls: string[] = [];
  const dragging = { current: false };
  const doc = new EventTarget();
  let clicks = 0;
  const drag = createDragController({
    shell: {
      dragStart: () => calls.push('start'),
      dragMove: () => calls.push('move'),
      dragEnd: () => calls.push('end'),
    },
    dragging,
    onClick: () => () => clicks++,
    doc,
  });
  const ev = (currentTarget: unknown, screenX = 100, screenY = 100, pointerId = 1): DragPointerEvent => ({
    pointerId,
    screenX,
    screenY,
    button: 0,
    currentTarget,
  });
  /** The browser telling the document about a pointer event (e.g. capture lost on removal). */
  const docEvent = (type: string, pointerId = 1) => doc.dispatchEvent(Object.assign(new Event(type), { pointerId }));
  return { drag, calls, dragging, doc, ev, docEvent, clicks: () => clicks };
}

describe('drag controller', () => {
  it('a press that barely moves is a click; a real move is a drag', () => {
    const { drag, calls, dragging, ev, clicks } = setup();
    const h = new Handle();
    drag.down(ev(h));
    expect(dragging.current).toBe(true);
    drag.move(ev(h, 102, 101));
    drag.up(ev(h, 102, 101));
    expect(clicks()).toBe(1);
    expect(calls).toEqual(['start', 'end']);
    expect(h.captured.size).toBe(0);

    drag.down(ev(h));
    drag.move(ev(h, 140, 120));
    drag.move(ev(h, 160, 130));
    drag.up(ev(h, 160, 130));
    expect(clicks()).toBe(1);
    expect(calls).toEqual(['start', 'end', 'start', 'move', 'move', 'end']);
    expect(dragging.current).toBe(false);
  });

  it('ends the drag when the handle is remounted mid-drag (capture lost at the document)', () => {
    const { drag, calls, dragging, ev, docEvent, clicks } = setup();
    const old = new Handle();
    drag.down(ev(old));
    drag.move(ev(old, 150, 150));
    // A new message expands the note: mini Clippy's element is removed, so the browser
    // fires lostpointercapture at the document and nothing at the (gone) handle.
    old.connected = false;
    docEvent('lostpointercapture');
    expect(calls).toEqual(['start', 'move', 'end']);
    expect(dragging.current).toBe(false);
    expect(drag.active).toBe(false);
    // The release then lands on the remounted Clippy: no click, no second dragEnd.
    drag.up(ev(new Handle(), 150, 150));
    expect(clicks()).toBe(0);
    expect(calls).toEqual(['start', 'move', 'end']);
  });

  it('a release on another element ends a not-yet-moved press without clicking', () => {
    const { drag, calls, ev, clicks } = setup();
    const old = new Handle();
    drag.down(ev(old));
    old.connected = false; // remounted before any move; no lostpointercapture seen
    drag.up(ev(new Handle()));
    expect(clicks()).toBe(0);
    expect(calls).toEqual(['start', 'end']);
  });

  it('a release that only reaches the document still ends the drag', () => {
    const { drag, calls, dragging, ev, docEvent, clicks } = setup();
    drag.down(ev(new Handle()));
    drag.move(ev(null, 200, 200));
    docEvent('pointerup', 2); // another pointer: ignored
    expect(dragging.current).toBe(true);
    docEvent('pointerup');
    expect(dragging.current).toBe(false);
    expect(calls).toEqual(['start', 'move', 'end']);
    expect(clicks()).toBe(0);
    // Listeners are gone once the drag is over.
    drag.down(ev(new Handle()));
    drag.up(ev(null));
    docEvent('pointercancel');
    expect(calls.filter((c) => c === 'end')).toHaveLength(2);
  });

  it('cancel and lost capture on the handle end the drag without a click; other buttons are ignored', () => {
    const { drag, calls, ev, clicks } = setup();
    const h = new Handle();
    drag.down({ ...ev(h), button: 2 });
    expect(calls).toEqual([]);
    drag.down(ev(h));
    drag.cancel(ev(h));
    drag.cancel(ev(h)); // the lostpointercapture that follows: already over
    expect(calls).toEqual(['start', 'end']);
    expect(clicks()).toBe(0);
  });
});
