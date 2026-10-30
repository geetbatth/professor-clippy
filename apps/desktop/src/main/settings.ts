/**
 * User settings persisted as `settings.json` in the app data dir (also read by the hook
 * and the MCP server, so it is written atomically).
 *
 * Loading is forgiving: each field is validated on its own, so one bad value (say a
 * hand-edited `workerUrl`) falls back to its default instead of discarding every setting.
 *
 * The Telegram bot token is kept encrypted (`telegramBotTokenEnc`, Electron `safeStorage`
 * through a {@link SecretBox}). A plaintext `telegramBotToken` found in the file (the headless
 * way to configure it) is encrypted into `telegramBotTokenEnc` on load and removed from the
 * file. The token itself is only ever available in main, from {@link SettingsStore.telegramToken}.
 */
import { readFile } from 'node:fs/promises';
import { applySettingsPatch, DEFAULT_SETTINGS, Settings, SettingsPatch } from '@clippy/shared';
import { writeAtomic } from './core/files';

export type SettingsListener = (next: Settings, prev: Settings) => void;

/** Encrypts strings at rest (Electron `safeStorage` in the app, a fake in tests). */
export interface SecretBox {
  /** False when the OS can't encrypt (then nothing secret is stored encrypted). */
  available(): boolean;
  /** Plaintext → an opaque string safe to store (base64). */
  encrypt(plain: string): string;
  /** The inverse of {@link encrypt}; throws if it can't be decrypted (another user or machine). */
  decrypt(stored: string): string;
}

/** The legacy / headless plaintext key; never written back. */
export const PLAINTEXT_TOKEN_KEY = 'telegramBotToken';

/** A Telegram bot token: `<bot id>:<secret>`. */
export const TELEGRAM_TOKEN_RE = /^\d{3,}:[A-Za-z0-9_-]{20,}$/;

/** Parse raw JSON into Settings, dropping (to the default) any field that doesn't validate. */
export function parseSettingsLenient(raw: unknown): Settings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const clean: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(Settings.shape)) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const parsed = schema.safeParse(value);
    if (parsed.success && parsed.data !== undefined) clean[key] = parsed.data;
  }
  return Settings.parse(clean);
}

export interface SettingsStoreOptions {
  /** Encryption for the Telegram token. Without it a token can't be saved (or migrated). */
  secrets?: SecretBox;
  log?: (message: string) => void;
}

export class SettingsStore {
  readonly #file: string;
  readonly #secrets: SecretBox | undefined;
  readonly #log: (message: string) => void;
  #current: Settings;
  /**
   * A plaintext token from the file that could not be encrypted (no `safeStorage` on this
   * machine): used in memory and kept in the file as it was, so nothing is lost.
   */
  #plainToken: string | undefined;
  #writes: Promise<void> = Promise.resolve();
  readonly #listeners = new Set<SettingsListener>();

  private constructor(file: string, initial: Settings, options: SettingsStoreOptions) {
    this.#file = file;
    this.#current = initial;
    this.#secrets = options.secrets;
    this.#log = options.log ?? ((m) => console.warn(`[clippy] ${m}`));
  }

  /**
   * Read `file` (missing or corrupt → defaults). Nothing is written until the first update,
   * except to encrypt a plaintext `telegramBotToken` (which is then removed from the file).
   */
  static async load(file: string, options: SettingsStoreOptions = {}): Promise<SettingsStore> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn(`[clippy] ${file} unreadable, using defaults:`, err);
    }
    const store = new SettingsStore(file, parseSettingsLenient(raw), options);
    const plain = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[PLAINTEXT_TOKEN_KEY] : undefined;
    if (typeof plain === 'string' && plain.trim()) await store.#migratePlainToken(plain.trim());
    return store;
  }

  get(): Settings {
    return this.#current;
  }

  /**
   * Validate and apply a patch (`null` clears an optional key), persist it, then notify
   * listeners. Throws (and changes nothing) if the patch is invalid. Writes are serialised.
   */
  async update(patch: SettingsPatch): Promise<Settings> {
    return this.#commit(applySettingsPatch(this.#current, SettingsPatch.parse(patch)));
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // ---- Telegram token -------------------------------------------------------

  /** True when a Telegram token is stored (encrypted, or the plaintext fallback). */
  get hasTelegramToken(): boolean {
    return this.#plainToken !== undefined || this.#current.telegramBotTokenEnc !== undefined;
  }

  /** The decrypted Telegram bot token, or undefined (none, or it can't be decrypted here). */
  telegramToken(): string | undefined {
    if (this.#plainToken !== undefined) return this.#plainToken;
    const enc = this.#current.telegramBotTokenEnc;
    if (enc === undefined || !this.#secrets) return undefined;
    try {
      return this.#secrets.decrypt(enc);
    } catch {
      this.#log('the saved Telegram bot token cannot be decrypted on this machine; save it again in Settings');
      return undefined;
    }
  }

  /**
   * Save (encrypted) or clear (`null`) the Telegram bot token. Throws for something that isn't
   * a bot token, or when this machine can't encrypt it.
   */
  async setTelegramToken(token: string | null): Promise<Settings> {
    if (token === null) {
      this.#plainToken = undefined;
      const { telegramBotTokenEnc: _drop, ...rest } = this.#current;
      return this.#commit(Settings.parse(rest));
    }
    const trimmed = token.trim();
    if (!TELEGRAM_TOKEN_RE.test(trimmed)) {
      throw new Error("That doesn't look like a bot token. BotFather gives you one like 123456789:AAH…");
    }
    if (!this.#secrets?.available()) throw new Error("Windows can't encrypt the token on this PC, so it wasn't saved.");
    const telegramBotTokenEnc = this.#secrets.encrypt(trimmed);
    this.#plainToken = undefined;
    return this.#commit(Settings.parse({ ...this.#current, telegramBotTokenEnc }));
  }

  async #migratePlainToken(plain: string): Promise<void> {
    if (!this.#secrets?.available()) {
      this.#plainToken = plain;
      this.#log('settings.json has a plaintext telegramBotToken and this PC cannot encrypt it; using it as it is');
      return;
    }
    const next = Settings.parse({ ...this.#current, telegramBotTokenEnc: this.#secrets.encrypt(plain) });
    this.#current = next;
    await this.#write(next); // the plaintext is gone from the file once this resolves
    this.#log('encrypted the Telegram bot token from settings.json (telegramBotToken → telegramBotTokenEnc)');
  }

  // ---- internals ------------------------------------------------------------

  async #commit(next: Settings): Promise<Settings> {
    const prev = this.#current;
    this.#current = next;
    try {
      await this.#write(next);
    } catch (err) {
      if (this.#current === next) this.#current = prev; // not persisted: don't pretend it was
      throw err;
    }
    for (const listener of [...this.#listeners]) {
      try {
        listener(next, prev);
      } catch (err) {
        console.error('[clippy] settings listener failed:', err);
      }
    }
    return next;
  }

  #write(settings: Settings): Promise<void> {
    const json = this.#plainToken === undefined ? settings : { ...settings, [PLAINTEXT_TOKEN_KEY]: this.#plainToken };
    const write = this.#writes.then(() => writeAtomic(this.#file, `${JSON.stringify(json, null, 2)}\n`));
    this.#writes = write.catch(() => {});
    return write;
  }
}
