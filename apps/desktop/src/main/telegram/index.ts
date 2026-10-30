/**
 * Starts, retargets and stops the Telegram channel as its settings change. With no bot token
 * it is off and makes no network calls at all.
 *
 * - A different token keeps the running channel and retargets it: the long-poll restarts with
 *   the new bot, and queued or retrying sends go out with the new token instead of being lost.
 *   Tokens are compared decrypted, so saving the same token again (safeStorage output differs
 *   every time) changes nothing.
 * - Clearing the token stops the channel (the user turned Telegram off).
 * - Pairing or unpairing a chat doesn't restart anything: the chat id is read live.
 * - Telegram message ids (`Message.tgMsgId`) only mean something for one bot and one chat.
 *   When either changes, they are all forgotten (kv `telegramRoute` remembers which pair they
 *   belong to), so an old id can never match a reply or edit a message in another chat.
 */
import { randomInt } from 'node:crypto';
import type { Message, TelegramStatus } from '@clippy/shared';
import type { SettingsStore } from '../settings';
import { TelegramApi } from './api';
import { Telegram, type TelegramDeps } from './telegram';

export { TelegramApi, TelegramApiError, redactToken } from './api';
export { MAX_WRONG_CODES, Telegram } from './telegram';

/** kv key of the current pairing code. */
export const PAIRING_KV_KEY = 'telegramPairingCode';
/** kv key: `<bot id>:<chat id>` the stored Telegram message ids belong to. */
export const ROUTE_KV_KEY = 'telegramRoute';
/** Pairing code alphabet: no 0/O or 1/I/L to misread. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

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
  /** The (decrypted) token the running channel uses. */
  #token: string | undefined;
  #undecryptable = false;

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

  /** Bring the channel in line with the current settings (called on every settings change). */
  apply(): void {
    const { settings } = this.#o;
    const token = settings.hasTelegramToken ? settings.telegramToken() : undefined;
    this.#undecryptable = settings.hasTelegramToken && token === undefined;
    if (token !== this.#token) {
      this.#token = token;
      if (token === undefined) {
        void this.#tg?.stop();
        this.#tg = undefined;
      } else if (this.#tg) {
        this.#tg.retarget(this.#api(token));
      } else {
        this.#tg = this.#start(token);
      }
    }
    this.#syncRoute();
  }

  #api(token: string): TelegramApi {
    const { baseUrl, fetch } = this.#o;
    return new TelegramApi({ token, ...(baseUrl !== undefined && { baseUrl }), ...(fetch && { fetch }) });
  }

  #start(token: string): Telegram {
    const { settings, baseUrl: _b, fetch: _f, ...deps } = this.#o;
    const tg = new Telegram({
      ...deps,
      api: this.#api(token),
      chatId: () => settings.get().telegramChatId,
      pairingCode: () => this.pairingCode(),
      pair: async ({ id, firstName }) => {
        await settings.update({ telegramChatId: id, telegramChatName: firstName || null });
        this.#o.store.deleteKv(PAIRING_KV_KEY);
      },
    });
    tg.start();
    return tg;
  }

  /** Forget every Telegram message id when the bot or the paired chat is not the one they belong to. */
  #syncRoute(): void {
    const chatId = this.#o.settings.get().telegramChatId;
    if (!this.#tg || chatId === undefined) return; // decided once there is a bot and a chat again
    const route = `${this.#tg.botId}:${chatId}`;
    const { store } = this.#o;
    const previous = store.getKv(ROUTE_KV_KEY);
    if (previous === route) return;
    // No record yet (first run with Telegram, or an upgrade): ids from before can only be this pair's.
    if (previous !== undefined) {
      const cleared = store.clearTgMsgIds();
      if (cleared) this.#o.log?.(`telegram: new bot or chat; forgot ${cleared} old Telegram message id(s)`);
    }
    store.setKv(ROUTE_KV_KEY, route);
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

  /** Save (encrypted) or clear the bot token; the settings change retargets or stops the channel. */
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
    this.#token = undefined;
    return tg?.stop() ?? Promise.resolve();
  }
}
