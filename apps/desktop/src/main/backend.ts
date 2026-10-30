/**
 * The `ClippyBackend` the renderer talks to over IPC, implemented over the core service,
 * the brain and the settings store.
 */
import type { ClippyBackend, Settings, TelegramStatus, TelegramTestResult } from '@clippy/shared';
import type { Asks } from './core/asks';
import { NotFoundError } from './core/errors';
import type { Store } from './core/store';
import type { BrainReply, Channel } from './brain/brain';
import type { ClaudeWiring } from './claudeWiring';
import type { SettingsStore } from './settings';

export interface BackendDeps {
  store: Store;
  asks: Asks;
  brain: { ask(text: string, opts?: { channel?: Channel }): Promise<BrainReply>; newChat(): void };
  settings: SettingsStore;
  /** "Connect Claude Code" (preview, then install). */
  claudeWiring: ClaudeWiring;
  /** The Telegram channel (`TelegramManager`). */
  telegram: TelegramControl;
}

/** What Settings needs from the Telegram channel. */
export interface TelegramControl {
  status(): TelegramStatus;
  setToken(token: string | null): Promise<TelegramStatus>;
  unpair(): Promise<TelegramStatus>;
  sendTest(): Promise<TelegramTestResult>;
}

/** Settings as the renderer sees them: without the (encrypted) Telegram token. */
export function forRenderer(settings: Settings): Settings {
  const { telegramBotTokenEnc: _secret, ...rest } = settings;
  return rest;
}

export function createBackend({ store, asks, brain, settings, claudeWiring, telegram }: BackendDeps): ClippyBackend {
  const found = <T>(value: T | undefined, id: string): T => {
    if (value === undefined) throw new NotFoundError(`No message ${id}`);
    return value;
  };

  return {
    async listMessages(filter) {
      return store.listMessages(filter);
    },
    async markDone(id) {
      return found(store.markDone(id), id);
    },
    async snooze(id, until) {
      return found(store.snooze(id, until), id);
    },
    async answerAsk(id, answer) {
      return asks.answer(id, answer, 'desk');
    },
    async sendChat(text) {
      const mine = store.createMessage({ kind: 'chat', role: 'user', sender: 'user', body: text, state: 'done' });
      // The reply streams to the renderer as chat:delta / chat:done.
      void brain.ask(text, { channel: 'desk' });
      return mine;
    },
    async newChat() {
      brain.newChat();
    },
    async searchHistory(q) {
      // History = dismissed agent notes, reminders and asks (chat has its own tab).
      return store.listMessages({ q, state: 'done' }).filter((m) => m.kind !== 'chat');
    },
    async getSettings() {
      return forRenderer(settings.get());
    },
    async setSettings(patch) {
      return forRenderer(await settings.update(patch));
    },
    async connectClaude(step) {
      return claudeWiring.connect(step);
    },
    async telegramStatus() {
      return telegram.status();
    },
    async setTelegramToken(token) {
      return telegram.setToken(token);
    },
    async telegramUnpair() {
      return telegram.unpair();
    },
    async telegramSendTest() {
      return telegram.sendTest();
    },
  };
}
