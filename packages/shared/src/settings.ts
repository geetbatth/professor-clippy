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
  /**
   * The hook's agent-finished notes (`quietIfActive`) only interrupt you once the PC has had no
   * keyboard or mouse input for this many seconds; before that they go straight to history.
   * 0 = always interrupt.
   */
  awayThresholdS: z.number().int().nonnegative().max(24 * 60 * 60),
  soundEnabled: z.boolean(),
  /**
   * What makes Clippy pop up (ding, quip, wiggle, open the note): 'important' = questions,
   * reminders, urgent notes and Clippy's own notes; 'everything' = every new note too.
   * Quiet arrivals still land in the stack with the unread badge.
   */
  popUpFor: z.enum(['important', 'everything']),
  /**
   * When notes, questions and reminders also go to the phone (WhatsApp, Telegram): 'away' = only
   * once you have been away from the PC for `awayThresholdS`, 'always' = at once. WhatsApp
   * reminders are still sent by the Worker on time either way.
   */
  phoneWhen: z.enum(['away', 'always']),
  /** Clippy may volunteer advice without being asked. */
  unsolicitedAdvice: z.boolean(),
  /** Clippy leaves a "Morning brief" note (today's reminders, what waits on you, what the agents did overnight). */
  briefEnabled: z.boolean(),
  /** Local time of the morning brief, 24-hour `HH:MM`. */
  briefTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM, 24-hour'),
  /** No morning brief on Saturdays and Sundays. */
  briefWeekdaysOnly: z.boolean(),
  /** Default `ask_user` wait, seconds. */
  askTimeoutDefaultS: z.number().int().positive(),
  /**
   * Global shortcut (an Electron accelerator, e.g. `Control+Alt+Space`) that opens the "Tell
   * Clippy" box from anywhere. Empty = no shortcut.
   */
  tellHotkey: z.string().max(60),
  /** Hide mini Clippy while a fullscreen app is focused. */
  hideOnFullscreen: z.boolean(),
  /** Launch at Windows login. */
  autoStart: z.boolean(),
  /**
   * Clippy's brain may ask to restart an app or the PC (`restart_app`, `restart_computer`). Each
   * request is still a question the user must confirm with a tap; the brain can never confirm it.
   */
  allowPowerActions: z.boolean(),
  /**
   * While the user is away (`awayThresholdS`), an agent's "allow this tool use?" prompt goes to the
   * desk note and the phone with Allow / Deny, and the user's tap answers the agent. Needs
   * `hookEnabled` (the hook asks). At the PC, Claude Code's own prompt shows as usual.
   */
  phoneApprovals: z.boolean(),
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
   * The one private Telegram chat Clippy talks to (your user id, always positive: group and
   * channel ids are negative and refused). Updates from any other chat are ignored. A numeric
   * string (hand-edited settings.json) is accepted too.
   */
  telegramChatId: z
    .union([z.number(), z.string().regex(/^-?\d+$/).transform(Number)])
    .pipe(
      z
        .number()
        .int()
        .positive('Only a private chat (a positive id) can be paired')
        .refine(Number.isSafeInteger, 'Not a Telegram chat id'),
    ),
  /** First name of the paired Telegram user (shown in Settings). */
  telegramChatName: z.string().min(1),
  /** The first-run wizard has been finished or skipped. */
  firstRunDone: z.boolean(),
  /**
   * Internal marker: the one-time "quiet by default" migration (advice quips off) has run.
   * Set by main on load and never patchable, so after it the user's own advice toggle wins.
   */
  quietDefaultsApplied: z.boolean(),
};

/** Full settings object with defaults applied. */
export const Settings = z.object({
  hookEnabled: fields.hookEnabled.default(true),
  awayThresholdS: fields.awayThresholdS.default(180),
  soundEnabled: fields.soundEnabled.default(true),
  popUpFor: fields.popUpFor.default('important'),
  phoneWhen: fields.phoneWhen.default('away'),
  unsolicitedAdvice: fields.unsolicitedAdvice.default(false),
  briefEnabled: fields.briefEnabled.default(true),
  briefTime: fields.briefTime.default('09:00'),
  briefWeekdaysOnly: fields.briefWeekdaysOnly.default(true),
  askTimeoutDefaultS: fields.askTimeoutDefaultS.default(600),
  tellHotkey: fields.tellHotkey.default('Control+Alt+Space'),
  hideOnFullscreen: fields.hideOnFullscreen.default(true),
  autoStart: fields.autoStart.default(true),
  allowPowerActions: fields.allowPowerActions.default(false),
  phoneApprovals: fields.phoneApprovals.default(false),
  workerUrl: fields.workerUrl.optional(),
  workerSecret: fields.workerSecret.optional(),
  windowPos: fields.windowPos.optional(),
  telegramBotTokenEnc: fields.telegramBotTokenEnc.optional(),
  telegramChatId: fields.telegramChatId.optional(),
  telegramChatName: fields.telegramChatName.optional(),
  firstRunDone: fields.firstRunDone.default(false),
  quietDefaultsApplied: fields.quietDefaultsApplied.default(false),
});
export type Settings = z.infer<typeof Settings>;

/** Default settings (what a fresh install uses). */
export const DEFAULT_SETTINGS: Settings = Object.freeze(Settings.parse({}));

/**
 * Partial update for `setSettings(patch)`. Omitted keys are left unchanged
 * (no defaults are applied). For the optional keys `workerUrl`, `workerSecret`,
 * `windowPos`, `telegramChatId` and `telegramChatName`, `null` clears the stored value.
 * The Telegram token is not patchable (main encrypts it: `setTelegramToken`), nor is
 * `quietDefaultsApplied`.
 */
export const SettingsPatch = z.object({
  hookEnabled: fields.hookEnabled.optional(),
  awayThresholdS: fields.awayThresholdS.optional(),
  soundEnabled: fields.soundEnabled.optional(),
  popUpFor: fields.popUpFor.optional(),
  phoneWhen: fields.phoneWhen.optional(),
  unsolicitedAdvice: fields.unsolicitedAdvice.optional(),
  briefEnabled: fields.briefEnabled.optional(),
  briefTime: fields.briefTime.optional(),
  briefWeekdaysOnly: fields.briefWeekdaysOnly.optional(),
  askTimeoutDefaultS: fields.askTimeoutDefaultS.optional(),
  tellHotkey: fields.tellHotkey.optional(),
  hideOnFullscreen: fields.hideOnFullscreen.optional(),
  autoStart: fields.autoStart.optional(),
  allowPowerActions: fields.allowPowerActions.optional(),
  phoneApprovals: fields.phoneApprovals.optional(),
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
