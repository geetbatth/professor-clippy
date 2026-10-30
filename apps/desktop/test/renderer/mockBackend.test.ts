import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatDone } from '@clippy/shared/ipc';
import { Message } from '@clippy/shared/schemas';
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
