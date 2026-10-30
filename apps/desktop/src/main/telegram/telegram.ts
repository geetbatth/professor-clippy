/**
 * The Telegram channel: a stand-in for (or companion to) WhatsApp that needs no Worker.
 * The desktop long-polls the Bot API (`getUpdates`) and sends with `sendMessage`; nothing
 * listens on the network.
 *
 * Outbound (same rule as WhatsApp, plus reminders, since there is no Worker to fire them):
 * - Every new `note`, `ask` and fired `reminder` Message goes to the paired chat; its Telegram
 *   `message_id` is stored on the Message (`tgMsgId`) to route replies and button taps.
 *   Reminders that fired together while the PC was off (catch-up on start or wake) go as one
 *   message marked "(missed while your PC was off)". Desk chat is not mirrored.
 * - An ask's options are an inline keyboard. When the ask is answered anywhere, its Telegram
 *   copy is edited to "✅ Answered: …" (best effort).
 * - Sends go out one at a time, in order, with bounded retries; a 429 waits `retry_after`.
 *
 * Inbound (only the paired private chat; any other chat, groups included, is ignored and
 * never answered):
 * - Before pairing, the first private `/start <code>` with the right code pairs that chat (a chat
 *   that sends MAX_WRONG_CODES wrong ones may not pair; the code never changes because of it).
 * - A tap on an ask's button answers it (`answeredVia: 'telegram'`); so does a text that uses
 *   Telegram's reply on an ask.
 * - `/start`, `/help`, `/notes` (unread notes) and `/new` (fresh brain session) are commands.
 * - Any other text is a brain turn on the `telegram` channel, its reply sent back, with a
 *   "typing…" indicator meanwhile.
 * - Updates are handled once: the offset (last `update_id` + 1) and the recent update ids are
 *   kept in kv per bot, so a restart neither reprocesses nor loses updates.
 */
import type { Message, TelegramState } from '@clippy/shared';
import type { BrainReply, Channel } from '../brain/brain';
import type { Asks } from '../core/asks';
import type { Bus } from '../core/bus';
import { ConflictError } from '../core/errors';
import type { Store } from '../core/store';
import {
  isAbortError,
  redactToken,
  TelegramApiError,
  type EditMessageTextParams,
  type SendMessageParams,
  type TelegramApi,
  type TgCallbackQuery,
  type TgMessage,
  type TgUpdate,
} from './api';
import {
  ANSWER_MAX,
  askKeyboard,
  ensureFits,
  escapeClipped,
  escapeHtml,
  formatForTelegram,
  formatMissedReminders,
  parseAskButton,
  splitForTelegram,
} from './format';

/** Long-poll length, seconds (Telegram holds `getUpdates` this long when there is nothing). */
export const POLL_TIMEOUT_S = 50;
export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
/** Delays before each retry of a failed send (5 attempts in all). */
export const RETRY_DELAYS_MS = [1_000, 5_000, 30_000, 2 * 60_000] as const;
/** A 429's `retry_after` is honoured up to this. */
export const MAX_RETRY_AFTER_S = 5 * 60;
/** Telegram shows "typing…" for about 5 s per `sendChatAction`. */
export const TYPING_INTERVAL_MS = 4_500;
/** kv key prefixes, per bot id: the next `getUpdates` offset, and recently handled update ids. */
export const OFFSET_KV_PREFIX = 'telegramOffset:';
export const SEEN_KV_PREFIX = 'telegramSeenUpdates:';
const SEEN_KEEP = 500;
const UNREAD_LIST_MAX = 10;
const ALLOWED_UPDATES = ['message', 'callback_query'];

export const HELP_TEXT = [
  '📎 <b>Professor Clippy</b> on Telegram',
  '',
  "Your agents' notes, reminders and questions arrive here.",
  '• Tap an answer under a question, or reply to it with your own.',
  '• Anything else you send goes to me; I answer here.',
  '',
  '/notes – what is unread on the desk',
  '/new – start a fresh chat',
  '/help – this list',
].join('\n');

export interface TelegramStatusSnapshot {
  state: Exclude<TelegramState, 'off'>;
  error?: string;
  botUsername?: string;
}

export interface TelegramDeps {
  store: Store;
  bus: Bus;
  asks: Asks;
  brain: { ask(text: string, opts?: { channel?: Channel }): Promise<BrainReply>; newChat(): void };
  api: TelegramApi;
  /** The paired chat id now, or undefined before pairing. */
  chatId(): number | undefined;
  /** The current pairing code (upper case), or undefined when there is none. */
  pairingCode(): string | undefined;
  /** Record a pairing (persists `telegramChatId`). */
  pair(chat: { id: number; firstName?: string }): Promise<void>;
  pollTimeoutS?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  retryDelaysMs?: readonly number[];
  typingIntervalMs?: number;
  log?: (message: string, err?: unknown) => void;
}

/**
 * Wrong `/start` codes one chat may send. After that the chat can't pair at all (until the
 * code changes or the app restarts); the code itself is never changed by a stranger.
 */
export const MAX_WRONG_CODES = 10;
/** Chats whose wrong codes are counted at once (a flood of chats can't grow memory without end). */
const WRONG_CODE_CHATS_MAX = 1000;

/** Reconnect delay before attempt `attempt` (0-based): `min` doubling, capped at `max`. */
export function backoffDelay(attempt: number, min = BACKOFF_MIN_MS, max = BACKOFF_MAX_MS): number {
  return Math.min(max, min * 2 ** Math.min(attempt, 30));
}

/** An error as one line for the log or the Settings status, never with the token in it. */
export function describeError(err: unknown): string {
  if (err instanceof TelegramApiError && err.status === 401) return 'Telegram rejected the bot token (401 Unauthorized).';
  if (err instanceof TelegramApiError && err.status === 409) {
    return 'Another program is reading this bot’s updates (409 Conflict). Only one Clippy per bot, and no webhook.';
  }
  return redactToken(err instanceof Error ? err.message : String(err));
}

export class Telegram {
  readonly #d: TelegramDeps;
  /** The bot this channel talks to; `retarget()` swaps it without losing queued sends. */
  #api: TelegramApi;
  /** The next poll may long-poll (the last call worked); false after start, an error or a new bot. */
  #healthy = false;
  /** Wrong pairing codes per chat id (see {@link MAX_WRONG_CODES}). */
  readonly #wrongCodes = new Map<number, number>();
  readonly #unsubscribe: (() => void)[] = [];
  /** Aborted by `stop()`: ends the long-poll, waits and sends in flight. */
  readonly #stop = new AbortController();
  /** Aborted by `poke()`: ends the current long-poll or backoff wait early. */
  #pollCtl = new AbortController();
  #running = false;
  #loop: Promise<void> = Promise.resolve();
  /** Outbound calls go out one at a time, in order. */
  #chain: Promise<void> = Promise.resolve();
  #status: TelegramStatusSnapshot = { state: 'connecting' };
  #botUsername: string | undefined;
  /** Missed reminder ids collected for one combined message. */
  #missed: string[] = [];
  readonly #typing = new Set<NodeJS.Timeout>();

  constructor(deps: TelegramDeps) {
    this.#d = deps;
    this.#api = deps.api;
  }

  /** The bot's id (the part of the token before the colon). */
  get botId(): string {
    return this.#api.botId;
  }

  /**
   * Talk to another bot (the token changed) without dropping anything: the long-poll restarts
   * with the new bot (its own offset), and queued or retrying sends go out with the new token.
   */
  retarget(api: TelegramApi): void {
    this.#api = api;
    this.#botUsername = undefined;
    this.#healthy = false;
    this.#wrongCodes.clear();
    this.#status = { state: 'connecting' };
    this.#pollCtl.abort();
  }

  get status(): TelegramStatusSnapshot {
    return { ...this.#status };
  }

  get running(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const { bus } = this.#d;
    this.#unsubscribe.push(
      bus.on('message:new', (m) => this.#onNew(m)),
      // No tgMsgId check here: an answer that lands while the ask's send is still in flight must
      // still edit it. The edit job runs after that send in the queue and re-reads the message.
      bus.on('ask:answered', ({ message }) => this.#editAnswered(message.id)),
    );
    this.#loop = this.#pollLoop();
  }

  /** Stop polling and sending (aborts the long-poll in flight). Resolves when the loop has ended. */
  stop(): Promise<void> {
    if (this.#running) {
      this.#running = false;
      for (const off of this.#unsubscribe.splice(0)) off();
      for (const t of this.#typing) clearInterval(t);
      this.#typing.clear();
      this.#stop.abort();
    }
    return this.#loop;
  }

  /** Poll again now (after the PC wakes), skipping any backoff wait. */
  poke(): void {
    if (this.#running) this.#pollCtl.abort();
  }

  /** Resolves once every queued send has settled (tests). */
  idle(): Promise<void> {
    return this.#chain;
  }

  /** Handle messages created before this channel was listening (the startup catch-up). */
  replay(messages: readonly Message[]): void {
    for (const m of messages) this.#onNew(m);
  }

  /** Send a test message to the paired chat, once (no retries), and report how it went. */
  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const chatId = this.#d.chatId();
    if (chatId === undefined) return { ok: false, error: 'No chat is paired yet: send /start with the code to your bot first.' };
    try {
      await this.#enqueue(
        'send test',
        async (signal) => {
          await this.#sendMessage(
            { chat_id: chatId, text: '📎 <b>Test from Professor Clippy.</b> Telegram works: notes, reminders and questions will arrive here.', parse_mode: 'HTML' },
            signal,
          );
        },
        { retries: false },
      );
      return { ok: true };
    } catch (err) {
      return { ok: false, error: describeError(err) };
    }
  }

  // ---- polling --------------------------------------------------------------

  /**
   * getMe once, then getUpdates for ever. The first poll after starting or after an error has
   * `timeout=0`, so it answers at once and the status shows "connected" straight away rather
   * than after a long-poll's 50 s; the rest are long-polls.
   */
  async #pollLoop(): Promise<void> {
    let attempt = 0;
    while (this.#running) {
      const api = this.#api; // retarget() may swap it; this round sticks to one bot
      this.#pollCtl = new AbortController();
      const poke = this.#pollCtl.signal;
      const signal = AbortSignal.any([poke, this.#stop.signal]);
      try {
        if (this.#botUsername === undefined) {
          const me = await api.getMe(signal);
          this.#botUsername = me.username ?? '';
        }
        const updates = await api.getUpdates(
          { offset: this.#offset(api), timeoutS: this.#healthy ? (this.#d.pollTimeoutS ?? POLL_TIMEOUT_S) : 0, allowedUpdates: ALLOWED_UPDATES },
          signal,
        );
        if (api !== this.#api) continue; // retargeted meanwhile: these belong to the old bot
        attempt = 0;
        this.#healthy = true;
        this.#setStatus({ state: 'connected' });
        for (const update of updates) {
          if (!this.#running) return;
          await this.#handleUpdate(update, api);
        }
      } catch (err) {
        if (!this.#running) return;
        if (poke.aborted) {
          attempt = 0;
          continue;
        }
        this.#healthy = false;
        const error = describeError(err);
        this.#setStatus({ state: 'error', error });
        // A 429 (from getUpdates or getMe too) says how long to wait: never poll sooner.
        const retryAfterMs =
          err instanceof TelegramApiError && err.retryAfterS !== undefined ? Math.min(err.retryAfterS, MAX_RETRY_AFTER_S) * 1000 : 0;
        const delay = Math.max(backoffDelay(attempt++, this.#d.backoffMinMs, this.#d.backoffMaxMs), retryAfterMs);
        this.#log(`telegram: polling failed; retrying in ${Math.round(delay / 100) / 10} s: ${error}`);
        await sleep(delay, AbortSignal.any([poke, this.#stop.signal]));
        if (poke.aborted) attempt = 0;
      }
    }
  }

  #setStatus(status: TelegramStatusSnapshot): void {
    this.#status = { ...status, ...(this.#botUsername && { botUsername: this.#botUsername }) };
  }

  #offset(api: TelegramApi): number | undefined {
    const raw = this.#d.store.getKv(OFFSET_KV_PREFIX + api.botId);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isSafeInteger(n) ? n : undefined;
  }

  #seen(api: TelegramApi): number[] {
    try {
      const raw = JSON.parse(this.#d.store.getKv(SEEN_KV_PREFIX + api.botId) ?? '[]');
      return Array.isArray(raw) ? raw.filter((x): x is number => typeof x === 'number') : [];
    } catch {
      return [];
    }
  }

  /** Handle one update at most once, then move the offset past it (even if handling threw). */
  async #handleUpdate(update: TgUpdate, api: TelegramApi): Promise<void> {
    const seen = this.#seen(api);
    if (!seen.includes(update.update_id)) {
      try {
        if (update.message) await this.#onMessage(update.message);
        else if (update.callback_query) await this.#onCallback(update.callback_query);
      } catch (err) {
        this.#log(`telegram: update ${update.update_id} failed`, err);
      }
      this.#d.store.setKv(SEEN_KV_PREFIX + api.botId, JSON.stringify([...seen, update.update_id].slice(-SEEN_KEEP)));
    }
    const next = update.update_id + 1;
    if ((this.#offset(api) ?? 0) < next) this.#d.store.setKv(OFFSET_KV_PREFIX + api.botId, String(next));
  }

  // ---- inbound --------------------------------------------------------------

  /** True for the paired private chat only. */
  #fromPaired(chat: { id: number; type: string } | undefined): chat is { id: number; type: 'private' } {
    const paired = this.#d.chatId();
    return paired !== undefined && chat?.type === 'private' && chat.id === paired;
  }

  async #onMessage(msg: TgMessage): Promise<void> {
    if (msg.chat.type !== 'private') return; // never groups or channels
    if (this.#d.chatId() === undefined) return this.#tryPair(msg);
    if (!this.#fromPaired(msg.chat)) return; // a stranger: ignored, never answered
    const chatId = msg.chat.id;
    const text = msg.text?.trim();
    if (!text) {
      this.#sendHtml(chatId, '📎 I can only read text, I’m afraid.');
      return;
    }
    if (text.startsWith('/')) return this.#command(chatId, text);

    const { store, asks } = this.#d;
    const replyTo = msg.reply_to_message?.message_id;
    const quoted = replyTo === undefined ? undefined : store.findMessageByTgMsgId(replyTo);
    if (quoted?.kind === 'ask') {
      try {
        asks.answer(quoted.id, text, 'telegram'); // the ask's copy is edited by the ask:answered listener
      } catch (err) {
        if (!(err instanceof ConflictError)) throw err;
        const current = store.getMessage(quoted.id);
        const via = current?.answeredVia ? ` (via ${current.answeredVia})` : '';
        this.#sendHtml(chatId, `📎 That question was already answered${escapeHtml(via)}: “${escapeClipped(current?.answer ?? '', ANSWER_MAX)}”.`);
      }
      return;
    }

    // Anything else is chat for the brain (one shared session with the desk and WhatsApp).
    store.createMessage({ kind: 'chat', role: 'user', sender: 'user', body: text, state: 'done' });
    const prompt = quoted ? `(Replying to your earlier message: “${quoted.body}”)\n${text}` : text;
    const stopTyping = this.#startTyping(chatId);
    void this.#d.brain.ask(prompt, { channel: 'telegram' }).then(
      (reply) => {
        stopTyping();
        if (reply.message) this.#sendReply(chatId, reply.message.body, reply.message);
        else this.#sendReply(chatId, `📎 ${reply.error ?? 'Clippy could not answer just now.'}`);
      },
      (err) => {
        stopTyping();
        this.#log('telegram: brain turn failed', err);
      },
    );
  }

  async #tryPair(msg: TgMessage): Promise<void> {
    const match = /^\/start(?:@\w+)?\s+(\S+)\s*$/i.exec(msg.text?.trim() ?? '');
    const code = this.#d.pairingCode();
    if (!match || !code) return; // not pairing: ignored, never answered
    const chatId = msg.chat.id;
    const wrong = this.#wrongCodes.get(chatId) ?? 0;
    if (wrong >= MAX_WRONG_CODES) return; // this chat guessed too often: it can't pair now
    if (match[1]!.toUpperCase() !== code.toUpperCase()) {
      if (!this.#wrongCodes.has(chatId) && this.#wrongCodes.size >= WRONG_CODE_CHATS_MAX) {
        this.#wrongCodes.delete(this.#wrongCodes.keys().next().value!);
      }
      this.#wrongCodes.set(chatId, wrong + 1);
      this.#log(`telegram: a /start with a wrong pairing code was ignored${wrong + 1 >= MAX_WRONG_CODES ? '; that chat may not pair any more' : ''}`);
      return;
    }
    this.#wrongCodes.clear();
    const firstName = msg.from?.first_name ?? msg.chat.first_name;
    await this.#d.pair({ id: msg.chat.id, ...(firstName !== undefined && { firstName }) });
    this.#log(`telegram: paired with chat ${msg.chat.id}`);
    this.#sendHtml(msg.chat.id, `✅ Paired! Hello${firstName ? ` ${escapeHtml(firstName)}` : ''}.\n\n${HELP_TEXT}`);
  }

  #command(chatId: number, text: string): void {
    const command = (text.split(/\s+/)[0] ?? '').toLowerCase().replace(/@\w+$/, '');
    switch (command) {
      case '/start':
      case '/help':
        this.#sendHtml(chatId, HELP_TEXT);
        return;
      case '/notes':
        this.#sendHtml(chatId, this.#unreadList());
        return;
      case '/new':
        this.#d.brain.newChat();
        this.#sendHtml(chatId, '🧹 New chat started. I have forgotten everything we said (professionally).');
        return;
      default:
        this.#sendHtml(chatId, `I don’t know ${escapeClipped(command, 64)}.\n\n${HELP_TEXT}`);
    }
  }

  #unreadList(): string {
    const unread = this.#d.store.listMessages({ state: 'unread' }).filter((m) => m.kind !== 'chat');
    if (!unread.length) return '📭 Nothing unread. Your desk is spotless.';
    const icon = (m: Message) => (m.kind === 'ask' ? '❓' : m.kind === 'reminder' ? '⏰' : '📝');
    const lines = unread.slice(0, UNREAD_LIST_MAX).map((m) => {
      const text = (m.title ?? m.body).replace(/\s+/g, ' ').trim();
      const short = text.length > 80 ? `${text.slice(0, 79)}…` : text;
      return `${m.urgent ? '🔴 ' : ''}${icon(m)} ${escapeHtml(short)} <i>— ${escapeClipped(m.sender, 40)}</i>`;
    });
    const more = unread.length > UNREAD_LIST_MAX ? `\n…and ${unread.length - UNREAD_LIST_MAX} more on desktop` : '';
    return `<b>${unread.length} unread</b>\n${lines.join('\n')}${more}`;
  }

  async #onCallback(cq: TgCallbackQuery): Promise<void> {
    // Only taps in the paired private chat, by its user; anything else is ignored, unanswered.
    if (!this.#fromPaired(cq.message?.chat) || cq.from.id !== this.#d.chatId()) return;
    const { store, asks } = this.#d;
    const parsed = parseAskButton(cq.data);
    const ask = parsed ? store.getMessage(parsed.askId) : undefined;
    const option = parsed && ask?.kind === 'ask' ? ask.options?.[parsed.index] : undefined;
    if (!ask || option === undefined) {
      this.#answerCallback(cq.id, 'That question is no longer on the desk.');
      return;
    }
    try {
      asks.answer(ask.id, option, 'telegram'); // the copy is edited by the ask:answered listener
      this.#answerCallback(cq.id, `✅ ${option}`);
    } catch (err) {
      if (!(err instanceof ConflictError)) throw err;
      const current = store.getMessage(ask.id);
      const via = current?.answeredVia ? ` (via ${current.answeredVia})` : '';
      this.#answerCallback(cq.id, `Already answered${via}: ${current?.answer ?? ''}`);
      this.#editAnswered(ask.id); // in case the copy still shows the buttons
    }
  }

  /** Acknowledge a button tap (best effort, not queued: Telegram wants it within seconds). */
  #answerCallback(id: string, text: string): void {
    this.#api
      .answerCallbackQuery({ callback_query_id: id, text: text.slice(0, 190) }, this.#stop.signal)
      .catch((err) => this.#running && this.#log('telegram: answerCallbackQuery failed', err));
  }

  /** "typing…" in the chat until the returned function is called. */
  #startTyping(chatId: number): () => void {
    const tick = () => {
      this.#api.sendChatAction({ chat_id: chatId, action: 'typing' }, this.#stop.signal).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, this.#d.typingIntervalMs ?? TYPING_INTERVAL_MS);
    timer.unref?.();
    this.#typing.add(timer);
    return () => {
      clearInterval(timer);
      this.#typing.delete(timer);
    };
  }

  // ---- outbound -------------------------------------------------------------

  #onNew(m: Message): void {
    if (!this.#running) return;
    // Same rule as WhatsApp (notes and asks), plus fired reminders: no Worker sends them here.
    // Desk chat is not mirrored; replies to Telegram chat are sent from #onMessage.
    if (m.kind === 'note' || m.kind === 'ask') this.#mirror(m.id);
    else if (m.kind === 'reminder') {
      if (m.missed) this.#collectMissed(m.id);
      else this.#mirror(m.id);
    }
  }

  #mirror(messageId: string): void {
    this.#post(`send ${messageId}`, async (signal) => {
      const chatId = this.#d.chatId();
      const m = this.#d.store.getMessage(messageId);
      // Still worth sending? (Paired, not sent yet, not dealt with in the meantime.)
      if (chatId === undefined || !m || m.tgMsgId !== undefined) return;
      if (m.kind === 'ask' ? m.answer !== undefined : m.state === 'done') return;
      const keyboard = m.kind === 'ask' ? askKeyboard(m) : undefined;
      const sent = await this.#sendMessage(
        {
          chat_id: chatId,
          text: formatForTelegram(m),
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          ...(keyboard && { reply_markup: keyboard }),
        },
        signal,
      );
      this.#d.store.updateMessage(m.id, { tgMsgId: sent.message_id });
    });
  }

  /** Reminders fired in one catch-up burst (one synchronous loop) go out as one message. */
  #collectMissed(messageId: string): void {
    this.#missed.push(messageId);
    if (this.#missed.length > 1) return;
    queueMicrotask(() => {
      const ids = this.#missed.splice(0);
      this.#post(`send ${ids.length} missed reminder(s)`, async (signal) => {
        const chatId = this.#d.chatId();
        if (chatId === undefined) return;
        const ms = ids
          .map((id) => this.#d.store.getMessage(id))
          .filter((m): m is Message => m !== undefined && m.tgMsgId === undefined && m.state !== 'done');
        if (!ms.length) return;
        const sent = await this.#sendMessage(
          { chat_id: chatId, text: formatMissedReminders(ms), parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
          signal,
        );
        for (const m of ms) this.#d.store.updateMessage(m.id, { tgMsgId: sent.message_id });
      });
    });
  }

  /** Edit an answered ask's copy to "✅ Answered: …" and drop its buttons (best effort). */
  #editAnswered(askId: string): void {
    this.#post(`edit answered ${askId}`, async (signal) => {
      const chatId = this.#d.chatId();
      const m = this.#d.store.getMessage(askId);
      if (chatId === undefined || m?.tgMsgId === undefined || m.answer === undefined) return;
      try {
        await this.#editMessage(
          {
            chat_id: chatId,
            message_id: m.tgMsgId,
            text: formatForTelegram(m, { answered: true }),
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            reply_markup: { inline_keyboard: [] },
          },
          signal,
        );
      } catch (err) {
        // Edited already (a second tap, say): nothing to do.
        if (err instanceof TelegramApiError && /not modified/i.test(err.description)) return;
        throw err;
      }
    });
  }

  /** Send a chat reply (split if long); the first part's id goes on `replyTo`. */
  #sendReply(chatId: number, text: string, replyTo?: Message): void {
    splitForTelegram(text).forEach((html, i) => {
      this.#post('send chat reply', async (signal) => {
        const sent = await this.#sendMessage({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, signal);
        if (i === 0 && replyTo && this.#d.store.getMessage(replyTo.id)?.tgMsgId === undefined) {
          this.#d.store.updateMessage(replyTo.id, { tgMsgId: sent.message_id });
        }
      });
    });
  }

  #sendHtml(chatId: number, html: string): void {
    this.#post('send', async (signal) => {
      await this.#sendMessage({ chat_id: chatId, text: html, parse_mode: 'HTML', link_preview_options: { is_disabled: true } }, signal);
    });
  }

  /** `sendMessage`, with the text made to fit (see {@link ensureFits}) whatever went into it. */
  #sendMessage(params: SendMessageParams, signal: AbortSignal): Promise<TgMessage> {
    return this.#api.sendMessage({ ...params, text: ensureFits(params.text) }, signal);
  }

  #editMessage(params: EditMessageTextParams, signal: AbortSignal): Promise<TgMessage | true> {
    return this.#api.editMessageText({ ...params, text: ensureFits(params.text) }, signal);
  }

  /** {@link enqueue} for fire-and-forget sends (a final failure is logged, not thrown). */
  #post(label: string, job: (signal: AbortSignal) => Promise<void>): void {
    this.#enqueue(label, job).catch(() => {});
  }

  /**
   * Run `job` after the jobs before it, retrying in place (so order holds) unless the failure
   * is permanent: after {@link RETRY_DELAYS_MS}, or a 429's `retry_after`. Rejects with the
   * last error once it gives up; resolves without running anything once stopped.
   */
  #enqueue(label: string, job: (signal: AbortSignal) => Promise<void>, options: { retries?: boolean } = {}): Promise<void> {
    if (!this.#running) return Promise.resolve();
    const run = this.#chain.then(async () => {
      const delays = options.retries === false ? [] : (this.#d.retryDelaysMs ?? RETRY_DELAYS_MS);
      for (let attempt = 0; ; attempt++) {
        if (!this.#running) return;
        try {
          await job(this.#stop.signal);
          return;
        } catch (err) {
          if (!this.#running || isAbortError(err)) return;
          const apiErr = err instanceof TelegramApiError ? err : undefined;
          if (apiErr?.permanent || attempt >= delays.length) {
            this.#log(`telegram: ${label} failed${apiErr?.permanent ? '' : ` after ${attempt + 1} attempt(s)`}; giving up: ${describeError(err)}`);
            throw err;
          }
          const wait =
            apiErr?.retryAfterS !== undefined ? Math.min(apiErr.retryAfterS, MAX_RETRY_AFTER_S) * 1000 : delays[attempt]!;
          this.#log(`telegram: ${label} failed; retrying in ${Math.round(wait / 100) / 10} s: ${describeError(err)}`);
          await sleep(wait, this.#stop.signal);
        }
      }
    });
    this.#chain = run.catch(() => {});
    return run;
  }

  #log(message: string, err?: unknown): void {
    const line = err === undefined ? message : `${message}: ${describeError(err)}`;
    if (this.#d.log) this.#d.log(line);
    else console.info(`[clippy] ${line}`);
  }
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}
