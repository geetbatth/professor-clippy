/**
 * Starts, restarts and stops the Telegram channel as its settings change. With no bot token
 * it is off and makes no network calls at all. A new token (or clearing it) stops the old
 * poller first; pairing or unpairing a chat doesn't restart anything (the chat id is read
 * live from settings).
 */
import { randomInt } from 'node:crypto';
import type { Message, TelegramStatus } from '@clippy/shared';
import type { SettingsStore } from '../settings';
import { TelegramApi } from './api';
import { Telegram, type TelegramDeps } from './telegram';

export { TelegramApi, TelegramApiError, redactToken } from './api';
export { Telegram } from './telegram';

/** kv key of the current pairing code. */
export const PAIRING_KV_KEY = 'telegramPairingCode';
/** Pairing code alphabet: no 0/O or 1/I/L to misread. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;
/** After this many wrong `/start` codes the code is replaced (guessing gets nowhere). */
export const MAX_WRONG_CODES = 10;

export function newPairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export interface TelegramManagerOptions
  extends Pick<TelegramDeps, 'store' | 'bus' | 'asks' | 'brain' | 'pollTimeoutS' | 'backoffMinMs' | 'backoffMaxMs' | 'retryDelaysMs' | 'typingIntervalMs' | 'log'> {
  settings: SettingsStore;
  /** Bot API base URL (tests point it at a fake server). */
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class TelegramManager {
  readonly #o: TelegramManagerOptions;
  #tg: Telegram | undefined;
  /** What the running channel was started for (the stored, encrypted token). */
  #key: string | undefined;
  #undecryptable = false;
  #wrongCodes = 0;

  constructor(options: TelegramManagerOptions) {
    this.#o = options;
  }

  /** True while the channel is running (a token is configured). */
  get active(): boolean {
    return this.#tg !== undefined;
  }

  /** The running channel (tests). */
  get channel(): Telegram | undefined {
    return this.#tg;
  }

  /** (Re)start for the current settings; does nothing if the token didn't change. */
  apply(): void {
    const { settings } = this.#o;
    const key = settings.hasTelegramToken ? (settings.get().telegramBotTokenEnc ?? 'plaintext') : undefined;
    if (key === this.#key) return;
    this.#key = key;
    void this.#tg?.stop();
    this.#tg = undefined;
    this.#undecryptable = false;
    if (key === undefined) return;
    const token = settings.telegramToken();
    if (!token) {
      this.#undecryptable = true;
      return;
    }
    const { settings: _s, baseUrl, fetch, ...deps } = this.#o;
    const api = new TelegramApi({ token, ...(baseUrl !== undefined && { baseUrl }), ...(fetch && { fetch }) });
    this.#tg = new Telegram({
      ...deps,
      api,
      chatId: () => settings.get().telegramChatId,
      pairingCode: () => this.pairingCode(),
      pair: async ({ id, firstName }) => {
        await settings.update({ telegramChatId: id, telegramChatName: firstName || null });
        this.#o.store.deleteKv(PAIRING_KV_KEY);
        this.#wrongCodes = 0;
      },
      onWrongCode: () => {
        if (++this.#wrongCodes >= MAX_WRONG_CODES) {
          this.#o.store.deleteKv(PAIRING_KV_KEY);
          this.#wrongCodes = 0;
        }
      },
    });
    this.#tg.start();
  }

  /** Send messages created before the channel listened (the startup catch-up). */
  replay(messages: readonly Message[]): void {
    this.#tg?.replay(messages);
  }

  /** The code to pair with (`/start <code>`): only while a token is saved and no chat is paired. */
  pairingCode(): string | undefined {
    const { settings, store } = this.#o;
    if (!settings.hasTelegramToken || settings.get().telegramChatId !== undefined) return undefined;
    let code = store.getKv(PAIRING_KV_KEY);
    if (!code || code.length !== CODE_LENGTH) {
      code = newPairingCode();
      store.setKv(PAIRING_KV_KEY, code);
    }
    return code;
  }

  status(): TelegramStatus {
    const s = this.#o.settings.get();
    const tokenSaved = this.#o.settings.hasTelegramToken;
    const base: TelegramStatus = {
      tokenSaved,
      state: 'off',
      ...(s.telegramChatId !== undefined && { chatId: s.telegramChatId }),
      ...(s.telegramChatName !== undefined && { chatName: s.telegramChatName }),
    };
    const code = this.pairingCode();
    if (code) base.pairingCode = code;
    if (this.#undecryptable) return { ...base, state: 'error', error: "The saved bot token can't be decrypted on this PC. Paste it again." };
    if (!this.#tg) return base;
    return { ...base, ...this.#tg.status };
  }

  /** Save (encrypted) or clear the bot token; the settings change restarts the channel. */
  async setToken(token: string | null): Promise<TelegramStatus> {
    await this.#o.settings.setTelegramToken(token);
    this.apply(); // in case nothing is listening to settings changes (tests)
    return this.status();
  }

  /** Forget the paired chat; a fresh pairing code is made. */
  async unpair(): Promise<TelegramStatus> {
    await this.#o.settings.update({ telegramChatId: null, telegramChatName: null });
    this.#o.store.deleteKv(PAIRING_KV_KEY);
    return this.status();
  }

  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    if (!this.#tg) return { ok: false, error: this.#undecryptable ? this.status().error : 'Save a bot token first.' };
    return this.#tg.sendTest();
  }

  /** Poll now (after the PC wakes from sleep). */
  poke(): void {
    this.#tg?.poke();
  }

  /** Stop the channel (the app is quitting). Resolves when its poll loop has ended. */
  stop(): Promise<void> {
    const tg = this.#tg;
    this.#tg = undefined;
    this.#key = undefined;
    return tg?.stop() ?? Promise.resolve();
  }
}
