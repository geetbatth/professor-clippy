/**
 * User settings, persisted as `settings.json` in the app data dir.
 *
 * `Settings.parse(raw)` fills in defaults for any missing key, so
 * `Settings.parse({})` yields {@link DEFAULT_SETTINGS}.
 */
import { z } from 'zod';

/** Saved position of mini Clippy (screen coordinates on an Electron display). */
export const WindowPos = z.object({
  x: z.number(),
  y: z.number(),
  /** Electron `Display.id`. */
  displayId: z.number(),
});
export type WindowPos = z.infer<typeof WindowPos>;

/** Field definitions without defaults; shared by `Settings` and `SettingsPatch`. */
const fields = {
  /** The Claude Code hook posts notes when an agent finishes / needs permission. */
  hookEnabled: z.boolean(),
  soundEnabled: z.boolean(),
  /** Clippy may volunteer advice without being asked. */
  unsolicitedAdvice: z.boolean(),
  /** Default `ask_user` wait, seconds. */
  askTimeoutDefaultS: z.number().int().positive(),
  /** Hide mini Clippy while a fullscreen app is focused. */
  hideOnFullscreen: z.boolean(),
  /** Launch at Windows login. */
  autoStart: z.boolean(),
  /** Base URL of the Cloudflare relay Worker (WhatsApp mirroring off when unset). */
  workerUrl: z.url(),
  /** Bearer secret for the relay Worker. */
  workerSecret: z.string().min(1),
  windowPos: WindowPos,
  /**
   * The Telegram bot token, encrypted with Electron `safeStorage` (base64). Never plaintext:
   * a plaintext `telegramBotToken` in settings.json is encrypted into this key on load and
   * removed. Set and cleared only by main (`setTelegramToken`), never by a settings patch.
   */
  telegramBotTokenEnc: z.string().min(1),
  /**
   * The one private Telegram chat Clippy talks to (your user id). Updates from any other chat
   * are ignored. A numeric string (hand-edited settings.json) is accepted too.
   */
  telegramChatId: z
    .union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)])
    .pipe(z.number().int().refine(Number.isSafeInteger, 'Not a Telegram chat id')),
  /** First name of the paired Telegram user (shown in Settings). */
  telegramChatName: z.string().min(1),
  /** The first-run wizard has been finished or skipped. */
  firstRunDone: z.boolean(),
};

/** Full settings object with defaults applied. */
export const Settings = z.object({
  hookEnabled: fields.hookEnabled.default(true),
  soundEnabled: fields.soundEnabled.default(true),
  unsolicitedAdvice: fields.unsolicitedAdvice.default(true),
  askTimeoutDefaultS: fields.askTimeoutDefaultS.default(600),
  hideOnFullscreen: fields.hideOnFullscreen.default(true),
  autoStart: fields.autoStart.default(true),
  workerUrl: fields.workerUrl.optional(),
  workerSecret: fields.workerSecret.optional(),
  windowPos: fields.windowPos.optional(),
  telegramBotTokenEnc: fields.telegramBotTokenEnc.optional(),
  telegramChatId: fields.telegramChatId.optional(),
  telegramChatName: fields.telegramChatName.optional(),
  firstRunDone: fields.firstRunDone.default(false),
});
export type Settings = z.infer<typeof Settings>;

/** Default settings (what a fresh install uses). */
export const DEFAULT_SETTINGS: Settings = Object.freeze(Settings.parse({}));

/**
 * Partial update for `setSettings(patch)`. Omitted keys are left unchanged
 * (no defaults are applied). For the optional keys `workerUrl`, `workerSecret`,
 * `windowPos`, `telegramChatId` and `telegramChatName`, `null` clears the stored value.
 * The Telegram token is not patchable (main encrypts it: `setTelegramToken`).
 */
export const SettingsPatch = z.object({
  hookEnabled: fields.hookEnabled.optional(),
  soundEnabled: fields.soundEnabled.optional(),
  unsolicitedAdvice: fields.unsolicitedAdvice.optional(),
  askTimeoutDefaultS: fields.askTimeoutDefaultS.optional(),
  hideOnFullscreen: fields.hideOnFullscreen.optional(),
  autoStart: fields.autoStart.optional(),
  workerUrl: fields.workerUrl.nullable().optional(),
  workerSecret: fields.workerSecret.nullable().optional(),
  windowPos: fields.windowPos.nullable().optional(),
  telegramChatId: fields.telegramChatId.nullable().optional(),
  telegramChatName: fields.telegramChatName.nullable().optional(),
  firstRunDone: fields.firstRunDone.optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

/** Apply a patch to settings: `undefined` keeps, `null` clears, anything else replaces. Returns a new object. */
export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Settings.parse(next);
}
