import { useEffect, type RefObject } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';

/** A finer test for a solid element: is the point (client coordinates) really on it? */
export type HitTest = (clientX: number, clientY: number) => boolean;

const hitTests = new WeakMap<Element, HitTest>();

/**
 * Give a `data-solid` element a finer hit test (Clippy's sprites use their alpha), or remove it.
 * Without one, the element's whole box catches the mouse.
 */
export function setHitTest(el: Element, test: HitTest | undefined): void {
  if (test) hitTests.set(el, test);
  else hitTests.delete(el);
}

/**
 * Elements (or their ancestors) marked `data-solid` catch the mouse; everything else clicks
 * through. An element with a hit test (`setHitTest`) only catches it where the test passes.
 */
export function isSolid(target: EventTarget | null, point?: { x: number; y: number }): boolean {
  if (!(target instanceof Element)) return false;
  const el = target.closest('[data-solid]');
  if (!el) return false;
  const test = point && hitTests.get(el);
  return test ? test(point.x, point.y) : true;
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
    const onMove = (e: MouseEvent) => set(isSolid(e.target, { x: e.clientX, y: e.clientY }));
    const onLeave = () => set(false);
    window.addEventListener('mousemove', onMove);
    document.documentElement.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.documentElement.removeEventListener('mouseleave', onLeave);
    };
  }, [shell, holdRef, onSolidEnter]);
}
