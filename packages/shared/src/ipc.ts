/**
 * Electron IPC contract between the desktop main process and the renderer.
 *
 * The preload script exposes `window.clippy: ClippyWindowApi`, implemented by
 * mapping each {@link ClippyBackend} method to `ipcRenderer.invoke(IpcInvoke[method], ...args)`
 * (handled in main with `ipcMain.handle`), and `on(event, cb)` to
 * `ipcRenderer.on(event, ...)` for the push events in {@link IpcEvents}.
 *
 * This module is type-only apart from the channel-name constants, so it is safe
 * to import from sandboxed preload and renderer code.
 */
import type { AskResult, Message, MessageFilter, StandingOrder } from './schemas';
import type { Settings, SettingsPatch } from './settings';

/** Brain activity, for Clippy's thinking animation. */
export type BrainState = 'idle' | 'thinking';

/** `chat:delta` payload: the next chunk of Clippy's in-progress chat reply. */
export interface ChatDelta {
  /** Text to append to the reply being streamed. */
  text: string;
}

/**
 * `chat:done` payload: the reply finished. `message` is the persisted
 * `kind: 'chat', role: 'clippy'` Message; `error` is set instead if the brain failed.
 */
export interface ChatDone {
  message?: Message;
  error?: string;
}

/** `connectClaude` step: show what would change (a dry run), or do it. */
export type ClaudeWiringStep = 'preview' | 'install';

/** Result of wiring Professor Clippy into Claude Code (MCP server, hooks, CLAUDE.md hint). */
export interface ClaudeWiringReport {
  /** False if the step failed; `error` says why. A failed install changes nothing. */
  ok: boolean;
  /** What the wiring printed: for `preview`, the plan ("would run / add / append ..."). */
  log: string[];
  error?: string;
  /** Things that won't stop the wiring but will stop it working (e.g. `node` not on PATH). */
  warnings: string[];
}

/** Telegram connection state, for the Settings status line. */
export type TelegramState = 'off' | 'connecting' | 'connected' | 'error';

/** What Settings shows about Telegram. Never contains the token. */
export interface TelegramStatus {
  /** A bot token is saved (encrypted). */
  tokenSaved: boolean;
  /** `off` without a token; otherwise the long-poll's state. */
  state: TelegramState;
  /** Why the last call failed (token redacted), when `state` is `error`. */
  error?: string;
  /** The bot's @username, once Telegram has confirmed the token. */
  botUsername?: string;
  /** The paired private chat. */
  chatId?: number;
  /** First name of the paired user. */
  chatName?: string;
  /** Token saved but no chat paired: send `/start <code>` to the bot to pair. */
  pairingCode?: string;
}

/** Result of "Send test". */
export interface TelegramTestResult {
  ok: boolean;
  error?: string;
}

/** State of the "Tell Clippy" global hotkey, for the Settings status line. */
export interface HotkeyStatus {
  /** The accelerator in use (`''` = no hotkey). */
  accelerator: string;
  /** False if it couldn't be registered (malformed, or another app has it); `error` says so. */
  ok: boolean;
  error?: string;
}

/** Request/response API the renderer calls (all async, via `ipcRenderer.invoke`). */
export interface ClippyBackend {
  /** Messages matching a filter (e.g. `{ state: 'unread' }` for the sticky-note stack). */
  listMessages(filter: MessageFilter): Promise<Message[]>;
  /** Dismiss a message into history. Also emits `message:updated`. */
  markDone(id: string): Promise<Message>;
  /** Snooze a message until `until` (epoch ms). Also emits `message:updated`. */
  snooze(id: string, until: number): Promise<Message>;
  /** Answer an ask from the desk (`answeredVia: 'desk'`). */
  answerAsk(id: string, answer: string): Promise<AskResult>;
  /** Send a chat line to Clippy's brain. Resolves with the stored user chat Message; the reply streams via `chat:delta` / `chat:done`. */
  sendChat(text: string): Promise<Message>;
  /** Start a fresh brain session (drops the resumed Claude Code session). */
  newChat(): Promise<void>;
  /** Full-text search over history. */
  searchHistory(q: string): Promise<Message[]>;
  getSettings(): Promise<Settings>;
  /** Apply a partial update and return the resulting settings. */
  setSettings(patch: SettingsPatch): Promise<Settings>;
  /**
   * Wire Professor Clippy into Claude Code (user scope). Call `'preview'` first and show its
   * log; call `'install'` only after the user confirms.
   */
  connectClaude(step: ClaudeWiringStep): Promise<ClaudeWiringReport>;
  /** Telegram's state, pairing code and paired chat. */
  telegramStatus(): Promise<TelegramStatus>;
  /**
   * Save the bot token (main encrypts it with `safeStorage`), or clear it with `null`, which
   * stops Telegram. Rejects a token that doesn't look like one (`123456:ABC...`).
   */
  setTelegramToken(token: string | null): Promise<TelegramStatus>;
  /** Forget the paired chat; a new pairing code is shown. */
  telegramUnpair(): Promise<TelegramStatus>;
  /** Send a test message to the paired chat. */
  telegramSendTest(): Promise<TelegramTestResult>;
  /** Whether the "Tell Clippy" global hotkey registered. */
  hotkeyStatus(): Promise<HotkeyStatus>;
  /** Active standing orders, oldest first. */
  listOrders(): Promise<StandingOrder[]>;
  /** Add a standing order (1 to 500 characters). */
  addOrder(text: string): Promise<StandingOrder>;
  /** Cancel a standing order. */
  cancelOrder(id: string): Promise<void>;
}

/** `ipcMain.handle` / `ipcRenderer.invoke` channel for each backend method. */
export const IpcInvoke = {
  listMessages: 'clippy:listMessages',
  markDone: 'clippy:markDone',
  snooze: 'clippy:snooze',
  answerAsk: 'clippy:answerAsk',
  sendChat: 'clippy:sendChat',
  newChat: 'clippy:newChat',
  searchHistory: 'clippy:searchHistory',
  getSettings: 'clippy:getSettings',
  setSettings: 'clippy:setSettings',
  connectClaude: 'clippy:connectClaude',
  telegramStatus: 'clippy:telegramStatus',
  setTelegramToken: 'clippy:setTelegramToken',
  telegramUnpair: 'clippy:telegramUnpair',
  telegramSendTest: 'clippy:telegramSendTest',
  hotkeyStatus: 'clippy:hotkeyStatus',
  listOrders: 'clippy:listOrders',
  addOrder: 'clippy:addOrder',
  cancelOrder: 'clippy:cancelOrder',
} as const satisfies { [K in keyof ClippyBackend]: `clippy:${K}` };

/** Push-event channels (main → renderer via `webContents.send`). */
export const IpcEvents = {
  messageNew: 'message:new',
  messageUpdated: 'message:updated',
  chatDelta: 'chat:delta',
  chatDone: 'chat:done',
  brainState: 'brain:state',
} as const satisfies Record<string, keyof ClippyEventMap>;

/** Event channel name → payload type. */
export interface ClippyEventMap {
  'message:new': Message;
  'message:updated': Message;
  'chat:delta': ChatDelta;
  'chat:done': ChatDone;
  'brain:state': BrainState;
}

/** A push-event channel name. */
export type ClippyEvent = keyof ClippyEventMap;

/** What preload exposes as `window.clippy`. `on` returns an unsubscribe function. */
export type ClippyWindowApi = ClippyBackend & {
  on<E extends ClippyEvent>(event: E, cb: (payload: ClippyEventMap[E]) => void): () => void;
};
