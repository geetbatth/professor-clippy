import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WritePageResult } from '@clippy/shared/ipc';
import type { Page } from '@clippy/shared/schemas';
import { createSaveController, SAVE_DELAY_MS } from '../../src/renderer/src/note/pageSave';

const T0 = 1_000_000;

function page(patch: Partial<Page> = {}): Page {
  return {
    id: '01JBX0000000000000000000AA',
    title: 'Scratch',
    body: 'hello',
    color: null,
    pinned: false,
    popped: false,
    popBounds: null,
    author: 'you',
    project: null,
    unseen: false,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    ...patch,
  };
}

/** A fake `writePage` body save: records each call and answers like the store (or as told). */
function fakeServer(start = page()) {
  let current = start;
  const calls: { text: string; base: number }[] = [];
  /** Answer the next save with this instead of saving. */
  let refuseWith: Page | undefined;
  const save = vi.fn(async (text: string, base: number): Promise<WritePageResult> => {
    calls.push({ text, base });
    if (refuseWith) {
      const conflict = refuseWith;
      refuseWith = undefined;
      return { ok: false, conflict };
    }
    if (base !== current.updatedAt) return { ok: false, conflict: current };
    current = { ...current, body: text, updatedAt: current.updatedAt + 1 };
    return { ok: true, page: current };
  });
  return {
    save,
    calls,
    get current() {
      return current;
    },
    /** Someone else (Clippy, an agent) changes the page. */
    theirs(patch: Partial<Page>) {
      current = { ...current, ...patch, updatedAt: current.updatedAt + 1 };
      return current;
    },
    refuseNext(p: Page) {
      refuseWith = p;
    },
  };
}

describe('page save controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(start = page()) {
    const server = fakeServer(start);
    const onConflict = vi.fn();
    const onText = vi.fn();
    const ctl = createSaveController({ text: start.body, base: start.updatedAt, save: server.save, onConflict, onText, now: () => 42 });
    return { server, ctl, onConflict, onText };
  }

  it('waits 400 ms after the last keystroke, then saves the last text once', async () => {
    const { server, ctl } = setup();
    expect(SAVE_DELAY_MS).toBe(400);
    expect(ctl.state).toBe('saved');
    ctl.edit('h');
    ctl.edit('he');
    await vi.advanceTimersByTimeAsync(300);
    ctl.edit('hey');
    expect(ctl.state).toBe('dirty');
    await vi.advanceTimersByTimeAsync(399);
    expect(server.save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(server.calls).toEqual([{ text: 'hey', base: T0 }]);
    expect(ctl.state).toBe('saved');
    expect(ctl.savedAt).toBe(42);
  });

  it('flush() saves at once and resolves only after the save has landed (blur, page switch, collapse, quit)', async () => {
    const { server, ctl } = setup();
    ctl.edit('typed just now');
    let done = false;
    const flushed = ctl.flush().then(() => (done = true));
    expect(server.calls).toEqual([{ text: 'typed just now', base: T0 }]);
    expect(ctl.state).toBe('saving');
    await flushed;
    expect(done).toBe(true);
    expect(ctl.state).toBe('saved');
    expect(server.current.body).toBe('typed just now');
    // The debounce timer was cancelled: no second save later.
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.save).toHaveBeenCalledTimes(1);
  });

  it('flush() with nothing typed saves nothing', async () => {
    const { server, ctl } = setup();
    await ctl.flush();
    expect(server.save).not.toHaveBeenCalled();
  });

  it('typing while a save is on its way saves again afterwards, on the new base', async () => {
    const { server, ctl } = setup();
    ctl.edit('one');
    const flushed = ctl.flush();
    ctl.edit('one two');
    await flushed;
    expect(server.calls).toEqual([
      { text: 'one', base: T0 },
      { text: 'one two', base: T0 + 1 },
    ]);
    expect(ctl.state).toBe('saved');
  });

  it('a page changed meanwhile: the save is refused, the typed text stays, and onConflict gets their page', async () => {
    const { server, ctl, onConflict, onText } = setup();
    const theirs = server.theirs({ body: 'hello\nfrom Clippy', author: 'clippy-brain' });
    ctl.edit('hello, mine');
    await vi.advanceTimersByTimeAsync(400);
    expect(ctl.state).toBe('conflict');
    expect(ctl.text).toBe('hello, mine');
    expect(ctl.conflict).toEqual(theirs);
    expect(onConflict).toHaveBeenCalledWith(theirs);
    expect(onText).not.toHaveBeenCalled();
    expect(server.current.body).toBe('hello\nfrom Clippy');
    // More typing during the conflict is kept but not saved over theirs.
    ctl.edit('hello, mine!');
    await vi.advanceTimersByTimeAsync(1000);
    await ctl.flush();
    expect(server.save).toHaveBeenCalledTimes(1);
    expect(ctl.state).toBe('conflict');
  });

  it('"Keep mine" saves the typed text on top of their version', async () => {
    const { server, ctl } = setup();
    const theirs = server.theirs({ body: 'from Clippy' });
    ctl.edit('mine');
    await ctl.flush();
    expect(ctl.state).toBe('conflict');
    await ctl.resolve('mine');
    expect(server.calls.at(-1)).toEqual({ text: 'mine', base: theirs.updatedAt });
    expect(ctl.state).toBe('saved');
    expect(ctl.conflict).toBeUndefined();
    expect(server.current.body).toBe('mine');
  });

  it('"Use theirs" replaces the typed text with theirs and saves nothing', async () => {
    const { server, ctl, onText } = setup();
    const theirs = server.theirs({ body: 'from Clippy' });
    ctl.edit('mine');
    await ctl.flush();
    await ctl.resolve('theirs');
    expect(ctl.text).toBe('from Clippy');
    expect(onText).toHaveBeenCalledWith('from Clippy');
    expect(ctl.state).toBe('saved');
    expect(server.save).toHaveBeenCalledTimes(1);
    // The next edit is based on their version.
    ctl.edit('from Clippy, and me');
    await ctl.flush();
    expect(server.calls.at(-1)).toEqual({ text: 'from Clippy, and me', base: theirs.updatedAt });
    expect(server.current.body).toBe('from Clippy, and me');
  });

  it('a refusal where only the title, colour or pin changed is not a conflict: it saves again on the new base', async () => {
    const { server, ctl, onConflict } = setup();
    server.theirs({ title: 'Renamed' });
    ctl.edit('hello there');
    await ctl.flush();
    expect(onConflict).not.toHaveBeenCalled();
    expect(server.calls).toEqual([
      { text: 'hello there', base: T0 },
      { text: 'hello there', base: T0 + 1 },
    ]);
    expect(ctl.state).toBe('saved');
  });

  describe('someone else changes the page while it is open (page:changed)', () => {
    it('with nothing unsaved, their text is shown at once', () => {
      const { server, ctl, onText } = setup();
      ctl.remote(server.theirs({ body: 'from Clippy' }));
      expect(ctl.text).toBe('from Clippy');
      expect(onText).toHaveBeenCalledWith('from Clippy');
      expect(ctl.state).toBe('saved');
    });

    it('while typing, the typed text stays and the next save comes back as a conflict', async () => {
      const { server, ctl, onText, onConflict } = setup();
      ctl.edit('mine');
      const theirs = server.theirs({ body: 'from Clippy' });
      ctl.remote(theirs);
      expect(ctl.text).toBe('mine');
      expect(onText).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(ctl.state).toBe('conflict');
      expect(onConflict).toHaveBeenCalledWith(theirs);
    });

    it('during a conflict, a newer version of theirs replaces the one on offer', async () => {
      const { server, ctl, onConflict } = setup();
      server.theirs({ body: 'from Clippy' });
      ctl.edit('mine');
      await ctl.flush();
      const newer = server.theirs({ body: 'from Clippy, again' });
      ctl.remote(newer);
      expect(ctl.conflict).toEqual(newer);
      expect(onConflict).toHaveBeenLastCalledWith(newer);
      await ctl.resolve('mine');
      expect(server.calls.at(-1)).toEqual({ text: 'mine', base: newer.updatedAt });
    });

    it('ignores the echo of its own save and older versions', async () => {
      const { server, ctl, onText } = setup();
      ctl.edit('mine');
      await ctl.flush();
      ctl.remote(server.current);
      ctl.remote(page());
      expect(onText).not.toHaveBeenCalled();
      expect(ctl.text).toBe('mine');
    });

    it('a title change (a newer version with the same text) only moves the base', async () => {
      const { server, ctl, onText } = setup();
      ctl.remote(server.theirs({ title: 'Renamed' }));
      expect(onText).not.toHaveBeenCalled();
      ctl.edit('typed');
      await ctl.flush();
      expect(server.calls).toEqual([{ text: 'typed', base: T0 + 1 }]);
    });
  });

  it('a failed save keeps the text unsaved with the error, and the next flush tries again', async () => {
    const save = vi.fn<(text: string, base: number) => Promise<WritePageResult>>().mockRejectedValueOnce(new Error('pipe broke'));
    save.mockResolvedValue({ ok: true, page: page({ body: 'x', updatedAt: T0 + 1 }) });
    const ctl = createSaveController({ text: 'hello', base: T0, save });
    ctl.edit('x');
    await ctl.flush();
    expect(ctl.state).toBe('dirty');
    expect(ctl.error).toBe('pipe broke');
    await ctl.flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(ctl.state).toBe('saved');
    expect(ctl.error).toBeUndefined();
  });

  it('uses the injected timer', async () => {
    const timers: { fn: () => void; ms: number }[] = [];
    const cancel = vi.fn();
    const save = vi.fn(async (text: string): Promise<WritePageResult> => ({ ok: true, page: page({ body: text, updatedAt: T0 + 1 }) }));
    const ctl = createSaveController({
      text: '',
      base: T0,
      save,
      delayMs: 50,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return cancel;
      },
    });
    ctl.edit('a');
    ctl.edit('ab');
    expect(timers.map((t) => t.ms)).toEqual([50, 50]);
    expect(cancel).toHaveBeenCalledTimes(1);
    timers.at(-1)!.fn();
    await vi.waitFor(() => expect(save).toHaveBeenCalledWith('ab', T0));
  });
});
