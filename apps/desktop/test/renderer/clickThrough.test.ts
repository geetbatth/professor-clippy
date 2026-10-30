import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createClickThrough,
  HIT_MISS_ATTR,
  isSolidAt,
  setHitTest,
  type HitElement,
} from '../../src/renderer/src/hooks/clickThrough';

/** A stand-in DOM element: `solid` is what `closest('[data-solid]')` finds (itself, an ancestor, or none). */
class FakeEl implements HitElement {
  readonly attrs = new Set<string>();
  solid: FakeEl | null;
  constructor(
    readonly name: string,
    solid: FakeEl | 'self' | null,
  ) {
    this.solid = solid === 'self' ? this : solid;
  }
  closest(selector: string): HitElement | null {
    expect(selector).toBe('[data-solid]');
    return this.solid;
  }
  toggleAttribute(name: string, force: boolean): boolean {
    if (force) this.attrs.add(name);
    else this.attrs.delete(name);
    return force;
  }
}

/**
 * The page at every point: elements topmost first. Like the browser, `elementFromPoint` skips
 * elements whose pointer events are off (`data-hit-miss`).
 */
function page(stack: FakeEl[]) {
  return (_x: number, _y: number) => stack.find((e) => !e.attrs.has(HIT_MISS_ATTR)) ?? null;
}

const note = new FakeEl('note', 'self');
const header = new FakeEl('note header', note);
const backdrop = new FakeEl('transparent container', null);
const registered: FakeEl[] = [];

/** Clippy's sprite: solid, with a hit test standing in for its alpha mask. */
function sprite(test: (x: number, y: number) => boolean): FakeEl {
  const el = new FakeEl('sprite', 'self');
  setHitTest(el, test);
  registered.push(el);
  return el;
}

afterEach(() => {
  for (const el of registered.splice(0)) setHitTest(el, undefined);
});

describe('isSolidAt', () => {
  it('a plain data-solid element is solid over its whole box', () => {
    expect(isSolidAt(page([header, backdrop]), 5, 5)).toBe(true);
    expect(isSolidAt(page([backdrop]), 5, 5)).toBe(false);
    expect(isSolidAt(() => null, 5, 5)).toBe(false);
  });

  it('a hit-tested element is solid only where its test passes', () => {
    const s = sprite((x) => x < 10);
    expect(isSolidAt(page([s, backdrop]), 5, 5)).toBe(true);
    expect(s.attrs.has(HIT_MISS_ATTR)).toBe(false);
    expect(isSolidAt(page([s, backdrop]), 20, 5)).toBe(false);
    expect(s.attrs.has(HIT_MISS_ATTR)).toBe(true);
  });

  it('a mask miss falls through to what is underneath (the note header between his wheels)', () => {
    const s = sprite(() => false);
    expect(isSolidAt(page([s, header, backdrop]), 5, 5)).toBe(true);
    // Marked, so the browser sends the press to the header, not to Clippy.
    expect(s.attrs.has(HIT_MISS_ATTR)).toBe(true);
  });

  it('clears the miss mark when the cursor comes back onto him, and when the test is removed', () => {
    let on = false;
    const s = sprite(() => on);
    isSolidAt(page([s]), 5, 5);
    expect(s.attrs.has(HIT_MISS_ATTR)).toBe(true);
    on = true;
    expect(isSolidAt(page([s]), 5, 5)).toBe(true);
    expect(s.attrs.has(HIT_MISS_ATTR)).toBe(false);
    on = false;
    isSolidAt(page([s]), 5, 5);
    setHitTest(s, undefined);
    expect(s.attrs.has(HIT_MISS_ATTR)).toBe(false);
  });
});

describe('createClickThrough', () => {
  function setup(stack: FakeEl[]) {
    const setIgnoreMouse = vi.fn();
    const onSolidEnter = vi.fn();
    let holding = false;
    const ct = createClickThrough({ setIgnoreMouse, onSolidEnter, hold: () => holding, elementFromPoint: page(stack) });
    return { ct, setIgnoreMouse, onSolidEnter, hold: (h: boolean) => (holding = h) };
  }

  it('captures over his opaque pixels and lets clicks through elsewhere', () => {
    const s = sprite((x) => x < 10);
    const { ct, setIgnoreMouse, onSolidEnter } = setup([s, backdrop]);
    ct.move(5, 5);
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(false);
    expect(onSolidEnter).toHaveBeenCalledOnce();
    ct.move(6, 5); // still solid: no extra IPC
    expect(setIgnoreMouse).toHaveBeenCalledOnce();
    ct.move(20, 5);
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(true);
    ct.move(5, 5);
    ct.leave();
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(true);
  });

  it('re-checks a still cursor when the pose changes under it (mini → knock and back)', () => {
    let pose: 'mini' | 'knock' = 'mini';
    // The cursor sits above mini Clippy's hat: empty for `mini`, his face once he pops up to knock.
    const s = sprite(() => pose === 'knock');
    const { ct, setIgnoreMouse } = setup([s, backdrop]);
    ct.move(50, 40);
    expect(setIgnoreMouse).not.toHaveBeenCalled();
    pose = 'knock';
    ct.recheck();
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(false);
    pose = 'mini';
    ct.recheck();
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(true);
  });

  it('a re-check before the cursor has been seen, or after it left, does nothing', () => {
    const s = sprite(() => true);
    const { ct, setIgnoreMouse } = setup([s]);
    ct.recheck();
    ct.move(1, 1);
    ct.leave();
    setIgnoreMouse.mockClear();
    ct.recheck();
    expect(setIgnoreMouse).not.toHaveBeenCalled();
  });

  it('forgets the cursor when the window resizes, keeping capture until the next move', () => {
    const s = sprite((x) => x < 10);
    const { ct, setIgnoreMouse } = setup([s, backdrop]);
    ct.move(5, 5);
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(false);
    ct.forget(); // mini -> expanded: (5,5) is now somewhere else on screen
    ct.recheck();
    expect(setIgnoreMouse).toHaveBeenCalledOnce();
    ct.move(20, 5);
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(true);
  });

  it('never flips mid-drag', () => {
    const s = sprite((x) => x < 10);
    const { ct, setIgnoreMouse, hold } = setup([s, backdrop]);
    ct.move(5, 5);
    hold(true);
    ct.move(20, 5);
    ct.recheck();
    ct.leave();
    expect(setIgnoreMouse).toHaveBeenCalledOnce();
    hold(false);
    ct.move(20, 5);
    expect(setIgnoreMouse).toHaveBeenLastCalledWith(true);
  });
});
