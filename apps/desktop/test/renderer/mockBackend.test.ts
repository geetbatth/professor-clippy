import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDone } from '@clippy/shared/ipc';
import { Message, Page } from '@clippy/shared/schemas';
import { DEFAULT_SETTINGS } from '@clippy/shared/settings';
import { createMockBackend } from '../../src/renderer/src/mock/mockBackend';

const NOW = new Date(2026, 9, 30, 12, 0).getTime();

describe('mock backend', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ships valid sample data: notes, a reminder, an ask with options, chat and history', async () => {
    const b = createMockBackend();
    const all = await b.listMessages({});
    for (const m of all) expect(() => Message.parse(m)).not.toThrow();
    const unread = await b.listMessages({ state: 'unread' });
    expect(unread.map((m) => m.kind).sort()).toEqual(['ask', 'note', 'note', 'reminder']);
    expect(unread.some((m) => m.urgent)).toBe(true);
    expect(unread.find((m) => m.kind === 'ask')?.options?.length).toBeGreaterThan(1);
    expect((await b.listMessages({ kind: 'chat' })).map((m) => m.role).sort()).toEqual(['clippy', 'user']);
    expect((await b.listMessages({ state: 'done', kind: 'ask' }))[0]?.answer).toBe('17');
  });

  it('reports the hotkey from the current setting', async () => {
    const b = createMockBackend();
    expect(await b.hotkeyStatus()).toEqual({ accelerator: 'Control+Alt+Space', ok: true });
    await b.setSettings({ tellHotkey: '' });
    expect(await b.hotkeyStatus()).toEqual({ accelerator: '', ok: true });
  });

  it('takes the look settings and reports a light Windows, so the preview can show every theme', async () => {
    const b = createMockBackend();
    expect(await b.systemDark()).toBe(false);
    expect(await b.getSettings()).toMatchObject({ theme: 'classic', followSystemDark: false, darkTheme: 'night' });
    expect(await b.setSettings({ theme: 'night', followSystemDark: true })).toMatchObject({ theme: 'night', followSystemDark: true });
  });

  it('keeps standing orders: add, list, cancel', async () => {
    const b = createMockBackend();
    const order = await b.addOrder('say yes');
    expect(await b.listOrders()).toEqual([expect.objectContaining({ id: order.id, text: 'say yes', active: true })]);
    await b.cancelOrder(order.id);
    expect(await b.listOrders()).toEqual([]);
    await expect(b.cancelOrder(order.id + 'x')).rejects.toThrow(/No standing order/);
  });

  it('keeps watches: add, list, cancel', async () => {
    const b = createMockBackend();
    const watch = await b.addWatch({ project: 'payments', nudge: 'Deploy' });
    expect(await b.listWatches()).toEqual([expect.objectContaining({ id: watch.id, project: 'payments', event: 'finished', active: true })]);
    await b.cancelWatch(watch.id);
    expect(await b.listWatches()).toEqual([]);
    await expect(b.cancelWatch(watch.id + 'x')).rejects.toThrow(/No watch/);
  });

  it('lists newest first', async () => {
    const unread = await createMockBackend().listMessages({ state: 'unread' });
    const times = unread.map((m) => m.createdAt);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('markDone moves a note to history and emits message:updated', async () => {
    const b = createMockBackend();
    const updated = vi.fn();
    b.on('message:updated', updated);
    const [first] = await b.listMessages({ state: 'unread' });
    const done = await b.markDone(first!.id);
    expect(done).toMatchObject({ id: first!.id, state: 'done', doneAt: NOW });
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ id: first!.id, state: 'done' }));
    expect((await b.listMessages({ state: 'unread' })).map((m) => m.id)).not.toContain(first!.id);
  });

  it('snooze records the wake-up time', async () => {
    const b = createMockBackend();
    const [first] = await b.listMessages({ state: 'unread' });
    const snoozed = await b.snooze(first!.id, NOW + 600_000);
    expect(snoozed).toMatchObject({ state: 'snoozed', snoozedUntil: NOW + 600_000 });
  });

  it('answerAsk answers from the desk and rejects non-asks', async () => {
    const b = createMockBackend();
    const unread = await b.listMessages({ state: 'unread' });
    const ask = unread.find((m) => m.kind === 'ask')!;
    await expect(b.answerAsk(ask.id, 'Squash them')).resolves.toEqual({
      id: ask.id,
      status: 'answered',
      answer: 'Squash them',
      answeredVia: 'desk',
    });
    const note = unread.find((m) => m.kind === 'note')!;
    await expect(b.answerAsk(note.id, 'x')).rejects.toThrow(/not an ask/);
    await expect(b.markDone('nope')).rejects.toThrow(/No message/);
  });

  it('streams a chat reply: thinking, deltas, done, idle', async () => {
    const b = createMockBackend({ thinkMs: 100, chunkMs: 10 });
    const events: string[] = [];
    let streamed = '';
    let done: ChatDone | undefined;
    b.on('brain:state', (s) => events.push(`brain:${s}`));
    b.on('chat:delta', (d) => {
      streamed += d.text;
    });
    b.on('chat:done', (d) => {
      done = d;
      events.push('done');
    });

    const mine = await b.sendChat('Any advice?');
    expect(mine).toMatchObject({ kind: 'chat', role: 'user', body: 'Any advice?' });
    expect(events).toEqual(['brain:thinking']);
    await vi.runAllTimersAsync();
    expect(events).toEqual(['brain:thinking', 'done', 'brain:idle']);
    expect(done?.message?.body).toBe(streamed);
    expect(done?.message).toMatchObject({ kind: 'chat', role: 'clippy' });
    expect(() => Message.parse(done?.message)).not.toThrow();
  });

  it('searchHistory finds done messages by text, sender or answer', async () => {
    const b = createMockBackend();
    expect((await b.searchHistory('feature/search')).length).toBe(1);
    expect((await b.searchHistory('CODEX')).map((m) => m.answer)).toEqual(['17']);
    expect(await b.searchHistory('migration')).toEqual([]); // still unread, not history
  });

  it('settings: defaults, patching and clearing', async () => {
    const b = createMockBackend();
    expect(await b.getSettings()).toEqual({ ...DEFAULT_SETTINGS, firstRunDone: true });
    expect((await createMockBackend({ firstRun: true }).getSettings()).firstRunDone).toBe(false);
    expect(await b.setSettings({ soundEnabled: false, workerUrl: 'https://relay.example.com' })).toMatchObject({
      soundEnabled: false,
      workerUrl: 'https://relay.example.com',
    });
    expect((await b.setSettings({ workerUrl: null })).workerUrl).toBeUndefined();
    await expect(b.setSettings({ workerUrl: 'not a url' })).rejects.toThrow();
  });

  it('ships valid sample pages: your pinned scratch page, one by Clippy not opened yet, an agent checklist, one archived', async () => {
    const b = createMockBackend();
    const pages = await b.listPages({});
    for (const p of pages) expect(Page.parse(p)).toEqual(p);
    expect(pages.map((p) => [p.title, p.author, p.pinned, p.unseen])).toEqual([
      ['Scratch', 'you', true, false],
      ['Call Dave', 'clippy-brain', false, true],
      ['Deploy steps', 'claude-code', false, false],
    ]);
    expect(pages[2]?.project).toBe('payments-api');
    const archived = await b.listPages({ archived: true });
    expect(archived.map((p) => p.title)).toEqual(['Christmas party ideas']);
    expect(Page.parse(archived[0])).toEqual(archived[0]);
  });

  it('keeps pages in memory like the app: seen when you write, stale saves come back as a conflict', async () => {
    const b = createMockBackend({ pages: [] });
    const changed = vi.fn();
    b.on('page:changed', changed);
    const page = await b.createPage({ title: 'Scratch', body: 'a' });
    expect(Page.parse(page)).toEqual(page);
    expect(page).toMatchObject({ author: 'you', unseen: false });
    vi.advanceTimersByTime(1000);
    const appended = await b.writePage(page.id, { append: 'b', baseUpdatedAt: page.updatedAt });
    expect(appended).toEqual({ ok: true, page: expect.objectContaining({ body: 'a\nb' }) });
    // Clippy writes meanwhile; a save based on the old version is refused with his.
    const theirs = b.pushPage({ ...page, body: 'from Clippy', author: 'clippy-brain' });
    expect(theirs.unseen).toBe(true);
    expect(await b.writePage(page.id, { body: 'mine', baseUpdatedAt: page.updatedAt })).toEqual({ ok: false, conflict: theirs });
    expect(await b.markPageSeen(page.id)).toMatchObject({ unseen: false });
    await b.createPage({ title: 'Other' });
    expect((await b.listPages({ q: 'clippy' })).map((p) => p.title)).toEqual(['Scratch']);
    expect(await b.popPage(page.id, true)).toMatchObject({ popped: true });
    expect(await b.archivePage(page.id)).toMatchObject({ popped: false, archivedAt: expect.any(Number) });
    expect((await b.listPages({ archived: true })).map((p) => p.id)).toEqual([page.id]);
    expect((await b.restorePage(page.id)).archivedAt).toBeNull();
    await expect(b.deletePage(page.id)).rejects.toThrow();
    await b.archivePage(page.id);
    const deleted = vi.fn();
    b.on('page:deleted', deleted);
    await b.deletePage(page.id);
    expect(deleted).toHaveBeenCalledWith({ id: page.id });
    await expect(b.getPage(page.id)).rejects.toThrow();
    expect(changed).toHaveBeenCalled();
  });

  it('pushMessage emits message:new; unsubscribe stops delivery', async () => {
    const b = createMockBackend();
    const seen = vi.fn();
    const off = b.on('message:new', seen);
    const m = b.pushMessage({ body: 'Deploy done', urgent: true });
    expect(() => Message.parse(m)).not.toThrow();
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ body: 'Deploy done', urgent: true, state: 'unread' }));
    off();
    b.pushMessage({ body: 'again' });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});
