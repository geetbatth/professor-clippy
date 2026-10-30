/**
 * Click-through for the transparent window, without React or DOM globals so it is testable:
 * per-element hit tests (Clippy's alpha masks) and the capture / let-through state.
 */

/** A finer test for a solid element: is the point (client coordinates) really on it? */
export type HitTest = (clientX: number, clientY: number) => boolean;

/** What click-through needs of an element (a DOM `Element`). */
export interface HitElement {
  closest(selector: string): HitElement | null;
  toggleAttribute(name: string, force: boolean): boolean;
}

const hitTests = new Map<HitElement, HitTest>();

/** Set on a hit-tested element while the cursor is over a part of its box it doesn't cover. */
export const HIT_MISS_ATTR = 'data-hit-miss';

/**
 * Give a `data-solid` element a finer hit test (Clippy's sprites use their alpha), or remove it.
 * Without one, the element's whole box catches the mouse.
 */
export function setHitTest(el: HitElement, test: HitTest | undefined): void {
  if (test) hitTests.set(el, test);
  else {
    hitTests.delete(el);
    el.toggleAttribute(HIT_MISS_ATTR, false);
  }
}

/**
 * Hit-tested elements first: each one the point misses is marked `data-hit-miss` (CSS turns its
 * pointer events off), so a press there falls through to whatever is underneath, e.g. the note
 * header between Clippy's wheels. Then the point is solid if the element that would get the press
 * (`elementFromPoint`, which now skips the marked ones) is inside a `data-solid` element.
 */
export function isSolidAt(elementFromPoint: (x: number, y: number) => HitElement | null, x: number, y: number): boolean {
  const results = new Map<HitElement, boolean>();
  for (const [el, test] of hitTests) {
    const hit = test(x, y);
    results.set(el, hit);
    el.toggleAttribute(HIT_MISS_ATTR, !hit);
  }
  const solid = elementFromPoint(x, y)?.closest('[data-solid]');
  // A hit-tested element only counts where its test passes (in case its miss mark didn't apply).
  return solid ? (results.get(solid) ?? true) : false;
}

export interface ClickThroughOptions {
  /** `true` = let clicks through (transparent area), `false` = capture. */
  setIgnoreMouse(ignore: boolean): void;
  /** While true (mid-drag), nothing flips, or the drag would lose the mouse. */
  hold(): boolean;
  onSolidEnter(): void;
  elementFromPoint(x: number, y: number): HitElement | null;
}

export interface ClickThrough {
  /** The cursor moved to (x, y), in client coordinates. */
  move(x: number, y: number): void;
  /** The cursor left the window. */
  leave(): void;
  /** Look again at the last cursor position (the layout changed under it). */
  recheck(): void;
  /**
   * The window moved or resized, so the last client position no longer points at the same spot
   * on screen. Drop it (keeping the current capture state) until the next forwarded move.
   */
  forget(): void;
}

/** Click-through state (no React): starts letting clicks through, captures over solid parts. */
export function createClickThrough(opts: ClickThroughOptions): ClickThrough {
  let capturing = false;
  let last: { x: number; y: number } | undefined;
  const set = (solid: boolean) => {
    if (solid === capturing) return;
    capturing = solid;
    opts.setIgnoreMouse(!solid);
    if (solid) opts.onSolidEnter();
  };
  const evaluate = () => {
    if (!last || opts.hold()) return;
    set(isSolidAt((x, y) => opts.elementFromPoint(x, y), last.x, last.y));
  };
  return {
    move(x, y) {
      last = { x, y };
      evaluate();
    },
    leave() {
      last = undefined;
      if (!opts.hold()) set(false);
    },
    recheck: evaluate,
    forget() {
      last = undefined;
    },
  };
}
