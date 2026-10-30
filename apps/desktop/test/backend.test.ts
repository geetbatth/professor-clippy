import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBackend } from '../src/main/backend';
import { Asks } from '../src/main/core/asks';
import { Bus } from '../src/main/core/bus';
import { ConflictError, NotFoundError } from '../src/main/core/errors';
import { Store } from '../src/main/core/store';
import { SettingsStore } from '../src/main/settings';

describe('createBackend', () => {
  let dir: string;
  let store: Store;
  let asks: Asks;
  let asked: [string, unknown][];
  let newChats: number;
  let backend: ReturnType<typeof createBackend>;
  let settings: SettingsStore;
  let telegramCalls: unknown[][];

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-backend-'));
    const bus = new Bus();
    store = new Store({ path: ':memory:', bus });
    asks = new Asks({ store, bus });
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
    backend = createBackend({ store, asks, brain, settings, claudeWiring, telegram, hotkey: () => ({ accelerator: 'Alt+T', ok: false, error: 'taken' }) });
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
    const b = createBackend({ store, asks, brain: { ask: async () => ({}), newChat: () => {} }, settings: withToken, claudeWiring: { connect: async () => ({ ok: true, log: [], warnings: [] }) }, hotkey: () => ({ accelerator: '', ok: true }), telegram: { status: () => ({ tokenSaved: true, state: 'off' }), setToken: async () => ({ tokenSaved: true, state: 'off' }), unpair: async () => ({ tokenSaved: true, state: 'off' }), sendTest: async () => ({ ok: true }) } });
    expect(withToken.get().telegramBotTokenEnc).toBeDefined();
    expect(await b.getSettings()).not.toHaveProperty('telegramBotTokenEnc');
    expect(await b.setSettings({ telegramChatId: 42 })).toMatchObject({ telegramChatId: 42 });
    expect(await b.setSettings({ soundEnabled: false })).not.toHaveProperty('telegramBotTokenEnc');
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
