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
import type { AskResult, Message, MessageFilter, NewPageInput, NewWatchInput, Page, PageChange, PageFilter, StandingOrder, Watch } from './schemas';
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

/**
 * Result of saving a page from the renderer: saved, or refused because the page changed since
 * the editor last saw it (`conflict` is the page as it is now; the editor keeps the user's text).
 */
export type WritePageResult = { ok: true; page: Page } | { ok: false; conflict: Page };

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
  /** Active watches ("nudge me when an agent finishes"), oldest first. */
  listWatches(): Promise<Watch[]>;
  /** Add a watch. */
  addWatch(input: NewWatchInput): Promise<Watch>;
  /** Cancel a watch. */
  cancelWatch(id: string): Promise<void>;
  /** Is Windows in dark mode right now (Electron `nativeTheme.shouldUseDarkColors`)? Changes arrive as `theme:system`. */
  systemDark(): Promise<boolean>;
  /** Pages on the Pad (not archived unless `archived`), pinned first, then most recently changed. */
  listPages(filter: PageFilter): Promise<Page[]>;
  getPage(id: string): Promise<Page>;
  /** A new page written by the user (seen). */
  createPage(input: NewPageInput): Promise<Page>;
  /** Save the user's change to a page; with `baseUpdatedAt`, refused as a conflict if it changed since. */
  writePage(id: string, change: PageChange): Promise<WritePageResult>;
  /** The user opened a page: it is no longer `unseen`. */
  markPageSeen(id: string): Promise<Page>;
  archivePage(id: string): Promise<Page>;
  restorePage(id: string): Promise<Page>;
  /** Delete an archived page for good (a page that is not archived is refused). */
  deletePage(id: string): Promise<void>;
  /** Open a page as its own window on the desktop (`true`) or put it back in the Pad. */
  popPage(id: string, popped: boolean): Promise<Page>;
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
  listWatches: 'clippy:listWatches',
  addWatch: 'clippy:addWatch',
  cancelWatch: 'clippy:cancelWatch',
  systemDark: 'clippy:systemDark',
  listPages: 'clippy:listPages',
  getPage: 'clippy:getPage',
  createPage: 'clippy:createPage',
  writePage: 'clippy:writePage',
  markPageSeen: 'clippy:markPageSeen',
  archivePage: 'clippy:archivePage',
  restorePage: 'clippy:restorePage',
  deletePage: 'clippy:deletePage',
  popPage: 'clippy:popPage',
} as const satisfies { [K in keyof ClippyBackend]: `clippy:${K}` };

/** Push-event channels (main → renderer via `webContents.send`). */
export const IpcEvents = {
  messageNew: 'message:new',
  messageUpdated: 'message:updated',
  chatDelta: 'chat:delta',
  chatDone: 'chat:done',
  brainState: 'brain:state',
  themeSystem: 'theme:system',
  pageChanged: 'page:changed',
  pageDeleted: 'page:deleted',
} as const satisfies Record<string, keyof ClippyEventMap>;

/** Event channel name → payload type. */
export interface ClippyEventMap {
  'message:new': Message;
  'message:updated': Message;
  'chat:delta': ChatDelta;
  'chat:done': ChatDone;
  'brain:state': BrainState;
  /** Windows switched between light and dark: `true` = dark (sent to every window). */
  'theme:system': boolean;
  /** A page was created or changed, by anyone (sent to every window). */
  'page:changed': Page;
  /** A page was deleted for good (sent to every window). */
  'page:deleted': { id: string };
}

/** A push-event channel name. */
export type ClippyEvent = keyof ClippyEventMap;

/** What preload exposes as `window.clippy`. `on` returns an unsubscribe function. */
export type ClippyWindowApi = ClippyBackend & {
  on<E extends ClippyEvent>(event: E, cb: (payload: ClippyEventMap[E]) => void): () => void;
};
