import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/main/backend';
import { Asks } from '../src/main/core/asks';
import { Bus } from '../src/main/core/bus';
import { ConflictError, NotFoundError } from '../src/main/core/errors';
import { Pages } from '../src/main/core/pages';
import { Store } from '../src/main/core/store';
import { SettingsStore } from '../src/main/settings';

describe('createBackend', () => {
  let dir: string;
  let store: Store;
  let asks: Asks;
  let pages: Pages;
  let pageEvents: string[];
  let asked: [string, unknown][];
  let newChats: number;
  let backend: ReturnType<typeof createBackend>;
  let settings: SettingsStore;
  let telegramCalls: unknown[][];
  let dark = false;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-backend-'));
    const bus = new Bus();
    store = new Store({ path: ':memory:', bus });
    asks = new Asks({ store, bus });
    pages = new Pages({ store, bus });
    pageEvents = [];
    bus.on('page:changed', (p) => pageEvents.push(`changed ${p.title}`));
    bus.on('page:deleted', ({ id }) => pageEvents.push(`deleted ${id}`));
    asked = [];
    newChats = 0;
    const brain = {
      ask: async (text: string, opts?: unknown) => {
        asked.push([text, opts]);
        return {};
      },
      newChat: () => {
        newChats++;
      },
    };
    const claudeWiring = { connect: async (step: string) => ({ ok: true, log: [step], warnings: [] }) };
    telegramCalls = [];
    const telegram = {
      status: () => ({ tokenSaved: false, state: 'off' as const }),
      setToken: async (token: string | null) => {
        telegramCalls.push(['setToken', token]);
        return { tokenSaved: token !== null, state: 'connecting' as const };
      },
      unpair: async () => {
        telegramCalls.push(['unpair']);
        return { tokenSaved: true, state: 'connected' as const, pairingCode: 'ABC234' };
      },
      sendTest: async () => ({ ok: false, error: 'not paired' }),
    };
    settings = await SettingsStore.load(join(dir, 'settings.json'));
    backend = createBackend({ store, asks, pages, brain, settings, claudeWiring, telegram, hotkey: () => ({ accelerator: 'Alt+T', ok: false, error: 'taken' }), systemDark: () => dark });
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists, dismisses and snoozes messages', async () => {
    const m = store.createMessage({ kind: 'note', body: 'deployed', sender: 'agent' });
    expect(await backend.listMessages({ state: 'unread' })).toEqual([m]);
    expect(await backend.snooze(m.id, 123)).toMatchObject({ state: 'snoozed', snoozedUntil: 123 });
    expect(await backend.markDone(m.id)).toMatchObject({ state: 'done' });
    await expect(backend.markDone('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toBeInstanceOf(NotFoundError);
    await expect(backend.snooze('01ARZ3NDEKTSV4RRFFQ69G5FAV', 1)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('answers asks from the desk', async () => {
    const ask = asks.create({ question: 'Ship it?', sender: 'agent' });
    expect(await backend.answerAsk(ask.id, 'yes')).toEqual({ id: ask.id, status: 'answered', answer: 'yes', answeredVia: 'desk' });
    await expect(backend.answerAsk(ask.id, 'no')).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores the user chat line in history and hands it to the brain', async () => {
    const mine = await backend.sendChat('Any wisdom?');
    expect(mine).toMatchObject({ kind: 'chat', role: 'user', sender: 'user', body: 'Any wisdom?', state: 'done' });
    expect(Message.parse(mine)).toEqual(mine);
    expect(asked).toEqual([['Any wisdom?', { channel: 'desk' }]]);
    await backend.newChat();
    expect(newChats).toBe(1);
  });

  it('searches dismissed agent messages, not chat', async () => {
    const note = store.createMessage({ kind: 'note', body: 'deployment finished', sender: 'agent' });
    store.markDone(note.id);
    store.createMessage({ kind: 'note', body: 'deployment pending', sender: 'agent' }); // still unread
    await backend.sendChat('how was the deployment?');
    expect((await backend.searchHistory('deploy')).map((m) => m.id)).toEqual([note.id]);
  });

  it('reads and writes settings', async () => {
    expect((await backend.getSettings()).soundEnabled).toBe(true);
    expect((await backend.setSettings({ soundEnabled: false })).soundEnabled).toBe(false);
    expect((await backend.getSettings()).soundEnabled).toBe(false);
  });

  it('never hands the encrypted Telegram token to the renderer', async () => {
    const secrets = { available: () => true, encrypt: (s: string) => `enc(${s})`, decrypt: (s: string) => s.slice(4, -1) };
    const withToken = await SettingsStore.load(join(dir, 'settings.json'), { secrets });
    await withToken.setTelegramToken('123456:AAHfakefakefakefakefakefake');
    const b = createBackend({ store, asks, pages, brain: { ask: async () => ({}), newChat: () => {} }, settings: withToken, claudeWiring: { connect: async () => ({ ok: true, log: [], warnings: [] }) }, hotkey: () => ({ accelerator: '', ok: true }), systemDark: () => false, telegram: { status: () => ({ tokenSaved: true, state: 'off' }), setToken: async () => ({ tokenSaved: true, state: 'off' }), unpair: async () => ({ tokenSaved: true, state: 'off' }), sendTest: async () => ({ ok: true }) } });
    expect(withToken.get().telegramBotTokenEnc).toBeDefined();
    expect(await b.getSettings()).not.toHaveProperty('telegramBotTokenEnc');
    expect(await b.setSettings({ telegramChatId: 42 })).toMatchObject({ telegramChatId: 42 });
    expect(await b.setSettings({ soundEnabled: false })).not.toHaveProperty('telegramBotTokenEnc');
  });

  it('adds, lists and cancels standing orders', async () => {
    const first = await backend.addOrder('When an agent asks which branch, answer: staging');
    await backend.addOrder('When an agent asks to run the tests, answer: yes');
    expect((await backend.listOrders()).map((o) => o.text)).toEqual([
      'When an agent asks which branch, answer: staging',
      'When an agent asks to run the tests, answer: yes',
    ]);
    await backend.cancelOrder(first.id);
    expect((await backend.listOrders()).map((o) => o.text)).toEqual(['When an agent asks to run the tests, answer: yes']);
    await expect(backend.cancelOrder('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('adds, lists and cancels watches', async () => {
    const first = await backend.addWatch({ project: 'payments', nudge: 'Deploy' });
    await backend.addWatch({ event: 'any', nudge: 'Look' });
    expect(first).toMatchObject({ project: 'payments', event: 'finished', active: true });
    expect((await backend.listWatches()).map((w) => w.nudge)).toEqual(['Deploy', 'Look']);
    await backend.cancelWatch(first.id);
    expect((await backend.listWatches()).map((w) => w.nudge)).toEqual(['Look']);
    await expect(backend.cancelWatch('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toBeInstanceOf(NotFoundError);
  });

  it("writes pages as 'you': seen, any page, and a stale save resolves to the conflict instead of throwing", async () => {
    const mine = await backend.createPage({ title: 'Scratch', body: 'v1' });
    expect(mine).toMatchObject({ author: 'you', unseen: false });
    const agents = pages.create({ title: 'Deploy steps', body: '1. build' }, 'claude-code');
    expect((await backend.listPages({})).map((p) => p.title)).toEqual(['Deploy steps', 'Scratch']);
    expect(await backend.markPageSeen(agents.id)).toMatchObject({ unseen: false });
    const edited = await backend.writePage(agents.id, { append: '2. ship', baseUpdatedAt: agents.updatedAt });
    expect(edited).toEqual({ ok: true, page: expect.objectContaining({ body: '1. build\n2. ship', author: 'claude-code', unseen: false }) });

    const clippys = pages.write(mine.id, { append: 'from Clippy' }, 'clippy-brain');
    expect(await backend.writePage(mine.id, { body: 'v1 and my typing', baseUpdatedAt: mine.updatedAt })).toEqual({ ok: false, conflict: clippys });
    expect((await backend.getPage(mine.id)).body).toBe('v1\nfrom Clippy');
    await expect(backend.getPage('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('pops, archives, restores and deletes pages, emitting page events', async () => {
    const page = await backend.createPage({ title: 'Float' });
    expect(await backend.popPage(page.id, true)).toMatchObject({ popped: true });
    expect(await backend.archivePage(page.id)).toMatchObject({ archivedAt: expect.any(Number), popped: false });
    expect((await backend.listPages({ archived: true })).map((p) => p.id)).toEqual([page.id]);
    expect(await backend.restorePage(page.id)).toMatchObject({ archivedAt: null });
    await expect(backend.deletePage(page.id)).rejects.toBeInstanceOf(ConflictError); // only archived pages
    await backend.archivePage(page.id);
    await backend.deletePage(page.id);
    expect(await backend.listPages({ archived: true })).toEqual([]);
    expect(pageEvents).toEqual(['changed Float', 'changed Float', 'changed Float', 'changed Float', 'changed Float', `deleted ${page.id}`]);
  });

  it('reports whether Windows is in dark mode as it is now', async () => {
    expect(await backend.systemDark()).toBe(false);
    dark = true;
    expect(await backend.systemDark()).toBe(true);
  });

  it('reports the Tell Clippy hotkey status', async () => {
    expect(await backend.hotkeyStatus()).toEqual({ accelerator: 'Alt+T', ok: false, error: 'taken' });
  });

  it('forwards the Telegram controls', async () => {
    expect(await backend.telegramStatus()).toEqual({ tokenSaved: false, state: 'off' });
    expect(await backend.setTelegramToken('123:x')).toMatchObject({ tokenSaved: true });
    expect(await backend.setTelegramToken(null)).toMatchObject({ tokenSaved: false });
    expect(await backend.telegramUnpair()).toMatchObject({ pairingCode: 'ABC234' });
    expect(await backend.telegramSendTest()).toEqual({ ok: false, error: 'not paired' });
    expect(telegramCalls).toEqual([['setToken', '123:x'], ['setToken', null], ['unpair']]);
    expect(settings.get()).toBeDefined();
  });

  it('forwards Connect Claude Code to the wiring', async () => {
    expect(await backend.connectClaude('preview')).toEqual({ ok: true, log: ['preview'], warnings: [] });
  });
});
