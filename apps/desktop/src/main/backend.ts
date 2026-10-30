/**
 * The `ClippyBackend` the renderer talks to over IPC, implemented over the core service,
 * the brain and the settings store.
 */
import type { ClippyBackend } from '@clippy/shared';
import type { Asks } from './core/asks';
import { NotFoundError } from './core/errors';
import type { Store } from './core/store';
import type { BrainReply, Channel } from './brain/brain';
import type { SettingsStore } from './settings';

export interface BackendDeps {
  store: Store;
  asks: Asks;
  brain: { ask(text: string, opts?: { channel?: Channel }): Promise<BrainReply>; newChat(): void };
  settings: SettingsStore;
}

export function createBackend({ store, asks, brain, settings }: BackendDeps): ClippyBackend {
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
      return settings.get();
    },
    async setSettings(patch) {
      return settings.update(patch);
    },
  };
}
