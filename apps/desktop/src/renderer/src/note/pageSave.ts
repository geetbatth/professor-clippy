/**
 * Saving a page's text as the user types, without React, so the edge cases are testable.
 *
 * Saves wait `SAVE_DELAY_MS` after the last keystroke, but never more than `SAVE_MAX_WAIT_MS` after
 * the first unsaved one (so steady typing saves too); `flush()` saves at once (the editor calls it
 * on blur, page switch, tab switch, collapse and `beforeunload`), so at most the last 400 ms of
 * typing can be lost. Every save carries `base`, the `updatedAt` the editor last saw: if Clippy or
 * an agent changed the page since, the store refuses it and hands back their version. The typed
 * text then stays put (state `conflict`) until the user picks "Keep mine" or "Use theirs".
 */
import type { WritePageResult } from '@clippy/shared/ipc';
import type { Page } from '@clippy/shared/schemas';

/** How long typing must pause before the text is saved, ms. */
export const SAVE_DELAY_MS = 400;
/** Typing that never pauses that long still saves once its first unsaved keystroke is this old, ms. */
export const SAVE_MAX_WAIT_MS = 2000;

/**
 * `saved`: the store has the text. `dirty`: typed, not saved yet (or the last save failed).
 * `saving`: a save is on its way. `conflict`: the page changed meanwhile; nothing saves until resolved.
 */
export type SaveState = 'saved' | 'saving' | 'dirty' | 'conflict';

export interface SaveControllerOptions {
  /** The page's text as loaded, and its `updatedAt`. */
  text: string;
  base: number;
  /** Save the text (`writePage(id, { body: text, baseUpdatedAt: base })`). */
  save(text: string, base: number): Promise<WritePageResult>;
  /** Default `SAVE_DELAY_MS`. */
  delayMs?: number;
  /** Default `SAVE_MAX_WAIT_MS`. */
  maxWaitMs?: number;
  /** Clock for `savedAt` and the longest wait (default `Date.now`). */
  now?: () => number;
  /** Start a timer; returns its cancel (default `setTimeout`). */
  setTimer?: (fn: () => void, ms: number) => () => void;
  /** Something the editor shows changed (state, text, error, the conflict). */
  onChange?(): void;
  /** A save was refused: `page` is the page as it is now. */
  onConflict?(page: Page): void;
  /** The text was replaced from outside ("Use theirs", or a change by someone else while nothing was unsaved). */
  onText?(text: string): void;
}

export interface SaveController {
  readonly state: SaveState;
  /** The text in the editor. */
  readonly text: string;
  /** When the text was last saved (at first, the page's `updatedAt`). */
  readonly savedAt: number;
  /** Their version, while in `conflict`. */
  readonly conflict: Page | undefined;
  /** Why the last save failed (cleared by the next one that works). */
  readonly error: string | undefined;
  /** The user typed: save after a pause. */
  edit(text: string): void;
  /** Save what is typed now; resolves once the store has it (or it was refused, or failed). */
  flush(): Promise<void>;
  /** Settle a conflict: save the typed text on top of theirs, or take theirs. */
  resolve(choice: 'mine' | 'theirs'): Promise<void>;
  /** The page changed (`page:changed`, or the result of another write such as a new title). */
  remote(page: Page): void;
  /**
   * The editor is going away (`beforeunload`, unmount): save what is typed. During a conflict
   * nothing may save, so the typed text goes to `onCopy` for the editor to keep as a copy, at once,
   * or once that last save comes back refused (someone wrote meanwhile). Only once per text, so a
   * quit followed by an unmount makes one copy.
   */
  leave(onCopy?: (text: string) => void): void;
}

const defaultTimer = (fn: () => void, ms: number) => {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
};

export function createSaveController(opts: SaveControllerOptions): SaveController {
  const delayMs = opts.delayMs ?? SAVE_DELAY_MS;
  const maxWaitMs = opts.maxWaitMs ?? SAVE_MAX_WAIT_MS;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultTimer;
  let text = opts.text;
  /** The text the store has at `base`. */
  let serverText = opts.text;
  let base = opts.base;
  let savedAt = opts.base;
  let conflict: Page | undefined;
  let error: string | undefined;
  let saving = false;
  let inflight: Promise<void> | undefined;
  /** The newest page heard of while a save was on its way; looked at once it lands. */
  let heard: Page | undefined;
  let cancelTimer: (() => void) | undefined;
  /** The typed text last handed out by `leave()` during this conflict. */
  let copied: string | undefined;
  /** When the oldest edit not yet on its way to the store was typed. */
  let dirtySince: number | undefined;

  const changed = () => opts.onChange?.();

  function stopTimer(): void {
    cancelTimer?.();
    cancelTimer = undefined;
  }

  /** Save after the usual pause, or sooner if the first unsaved edit is about to be `maxWaitMs` old. */
  function schedule(): void {
    stopTimer();
    const left = dirtySince === undefined ? delayMs : dirtySince + maxWaitMs - now();
    cancelTimer = setTimer(
      () => {
        cancelTimer = undefined;
        if (!saving) void saveOnce();
      },
      Math.max(0, Math.min(delayMs, left)),
    );
  }

  /** Hand the typed text over as a copy, unless that exact text already was. */
  function copyOnce(onCopy: ((text: string) => void) | undefined): void {
    if (!conflict || text === copied) return;
    copied = text;
    onCopy?.(text);
  }

  /** One save of the current text (retried on top of a change that left the text alone). */
  function saveOnce(): Promise<void> {
    if (conflict) return Promise.resolve();
    dirtySince = undefined;
    if (text === serverText) return Promise.resolve();
    saving = true;
    changed();
    const run = async () => {
      try {
        for (;;) {
          const sent = text;
          const result = await opts.save(sent, base);
          error = undefined;
          const page = result.ok ? result.page : result.conflict;
          // Saved, or someone else had already written exactly this: either way the store has it.
          if (result.ok || page.body === sent) {
            base = page.updatedAt;
            serverText = sent;
            savedAt = now();
            return;
          }
          // Only the title, colour or pin changed since: nobody's words are at stake, so save on top.
          if (page.body === serverText && page.updatedAt > base) {
            base = page.updatedAt;
            continue;
          }
          conflict = page;
          opts.onConflict?.(page);
          return;
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
    };
    const done = run().then(() => {
      saving = false;
      inflight = undefined;
      const later = heard;
      heard = undefined;
      if (later) remote(later);
      // Typed more while it was on its way: save that after the usual pause.
      if (!conflict && !error && text !== serverText && !cancelTimer) schedule();
      changed();
    });
    inflight = done;
    return done;
  }

  function remote(page: Page): void {
    if (saving) {
      if (!heard || page.updatedAt > heard.updatedAt) heard = page;
      return;
    }
    if (conflict) {
      if (page.updatedAt > conflict.updatedAt) {
        conflict = page;
        opts.onConflict?.(page);
        changed();
      }
      return;
    }
    if (page.updatedAt <= base) return; // the echo of our own save, or older news
    if (page.body === serverText) {
      base = page.updatedAt; // a new title, colour or pin
      return;
    }
    if (text === serverText) {
      // Nothing unsaved: show their text at once.
      text = serverText = page.body;
      base = page.updatedAt;
      opts.onText?.(text);
      changed();
    }
    // Mid-typing: leave the typed text alone; the next save is refused and offers both.
  }

  return {
    get state(): SaveState {
      if (conflict) return 'conflict';
      if (saving) return 'saving';
      return text === serverText ? 'saved' : 'dirty';
    },
    get text() {
      return text;
    },
    get savedAt() {
      return savedAt;
    },
    get conflict() {
      return conflict;
    },
    get error() {
      return error;
    },
    edit(next) {
      if (next === text) return;
      text = next;
      if (!conflict) {
        dirtySince ??= now();
        schedule();
      }
      changed();
    },
    async flush() {
      for (;;) {
        stopTimer();
        if (inflight) {
          await inflight;
          continue;
        }
        if (conflict || text === serverText) return;
        await saveOnce();
        if (error) return; // failed: the next edit or flush tries again
      }
    },
    async resolve(choice) {
      if (!conflict) return;
      const theirs = conflict;
      conflict = undefined;
      copied = undefined;
      dirtySince = undefined;
      base = theirs.updatedAt;
      serverText = theirs.body;
      if (choice === 'theirs') {
        stopTimer();
        text = theirs.body;
        opts.onText?.(text);
        changed();
        return;
      }
      changed();
      await this.flush();
    },
    remote,
    leave(onCopy) {
      if (conflict) return copyOnce(onCopy);
      // The last save may yet come back refused, after the editor has gone: copy then.
      void this.flush().then(() => copyOnce(onCopy));
    },
  };
}
