/**
 * In-memory `ClippyWindowApi` for developing and screenshotting the UI without the app's
 * main process (`?mock=1`, or whenever `window.clippy` is missing). Chat replies stream
 * through `chat:delta` / `chat:done` on timers, like the real brain.
 */
import { ulid } from 'ulid';
import type { ClippyEvent, ClippyEventMap, ClippyWindowApi, TelegramStatus } from '@clippy/shared/ipc';
import type { AskResult, Message, MessageFilter, StandingOrder, Watch } from '@clippy/shared/schemas';
import { applySettingsPatch, DEFAULT_SETTINGS, SettingsPatch, type Settings } from '@clippy/shared/settings';
import { MOCK_REPLIES, sampleMessages } from './sampleData';

export interface MockOptions {
  now?: () => number;
  /** Start with these messages instead of the samples. */
  messages?: Message[];
  /** Delay before the reply starts and between streamed chunks. */
  thinkMs?: number;
  chunkMs?: number;
  /** Start as a fresh install (the first-run wizard shows). */
  firstRun?: boolean;
  /** Start with a Telegram bot token saved (and this chat paired, if given). */
  telegram?: { chatId?: number; chatName?: string };
}

export interface MockBackend extends ClippyWindowApi {
  /** Simulate an agent posting a note (emits `message:new`). */
  pushMessage(input: Partial<Message> & Pick<Message, 'body'>): Message;
  /** Simulate `/start <code>` from Telegram (pairs if the code is right). */
  telegramStart(code: string, chat?: { id: number; firstName: string }): boolean;
}

function matches(m: Message, filter: MessageFilter): boolean {
  if (filter.state && m.state !== filter.state) return false;
  if (filter.kind && m.kind !== filter.kind) return false;
  if (filter.q && !containsText(m, filter.q)) return false;
  return true;
}

function containsText(m: Message, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [m.body, m.title, m.sender, m.project, m.answer].some((f) => f?.toLowerCase().includes(needle));
}

/** Newest first. */
const byNewest = (a: Message, b: Message) => b.createdAt - a.createdAt;

export function createMockBackend(opts: MockOptions = {}): MockBackend {
  const now = opts.now ?? Date.now;
  const thinkMs = opts.thinkMs ?? 900;
  const chunkMs = opts.chunkMs ?? 60;
  const messages = new Map((opts.messages ?? sampleMessages(now())).map((m) => [m.id, { ...m }]));
  let settings: Settings = {
    ...DEFAULT_SETTINGS,
    firstRunDone: !opts.firstRun,
    ...(opts.telegram?.chatId !== undefined && { telegramChatId: opts.telegram.chatId }),
    ...(opts.telegram?.chatName !== undefined && { telegramChatName: opts.telegram.chatName }),
  };
  let telegramToken = opts.telegram !== undefined;
  const pairingCode = 'K7QF3M';
  const telegramStatus = (): TelegramStatus => {
    if (!telegramToken) return { tokenSaved: false, state: 'off' };
    return {
      tokenSaved: true,
      state: 'connected',
      botUsername: 'ProfessorClippyBot',
      ...(settings.telegramChatId !== undefined ? { chatId: settings.telegramChatId } : { pairingCode }),
      ...(settings.telegramChatName !== undefined && { chatName: settings.telegramChatName }),
    };
  };
  const orders = new Map<string, StandingOrder>();
  const watches = new Map<string, Watch>();
  let previewed = false;
  let replyIndex = 0;
  const listeners = new Map<ClippyEvent, Set<(payload: never) => void>>();

  function emit<E extends ClippyEvent>(event: E, payload: ClippyEventMap[E]): void {
    for (const cb of listeners.get(event) ?? []) (cb as (p: ClippyEventMap[E]) => void)(payload);
  }

  function get(id: string): Message {
    const m = messages.get(id);
    if (!m) throw new Error(`No message ${id}`);
    return m;
  }

  function update(id: string, patch: Partial<Message>): Message {
    const next = { ...get(id), ...patch };
    messages.set(id, next);
    emit('message:updated', { ...next });
    return { ...next };
  }

  function streamReply(): void {
    const reply = MOCK_REPLIES[replyIndex++ % MOCK_REPLIES.length] ?? '';
    const chunks = reply.match(/\S+\s*/g) ?? [reply];
    emit('brain:state', 'thinking');
    chunks.forEach((text, i) => setTimeout(() => emit('chat:delta', { text }), thinkMs + i * chunkMs));
    setTimeout(() => {
      const t = now();
      const message: Message = {
        id: ulid(t),
        kind: 'chat',
        body: reply,
        sender: 'clippy',
        role: 'clippy',
        urgent: false,
        state: 'done',
        createdAt: t,
      };
      messages.set(message.id, message);
      emit('chat:done', { message: { ...message } });
      emit('brain:state', 'idle');
    }, thinkMs + chunks.length * chunkMs);
  }

  return {
    async listMessages(filter) {
      return [...messages.values()].filter((m) => matches(m, filter)).sort(byNewest).map((m) => ({ ...m }));
    },
    async markDone(id) {
      return update(id, { state: 'done', doneAt: now(), snoozedUntil: undefined });
    },
    async snooze(id, until) {
      return update(id, { state: 'snoozed', snoozedUntil: until });
    },
    async answerAsk(id, answer): Promise<AskResult> {
      const m = get(id);
      if (m.kind !== 'ask') throw new Error(`${id} is not an ask`);
      update(id, { answer, answeredVia: 'desk', state: 'done', doneAt: now() });
      return { id, status: 'answered', answer, answeredVia: 'desk' };
    },
    async sendChat(text) {
      const t = now();
      const message: Message = {
        id: ulid(t),
        kind: 'chat',
        body: text,
        sender: 'user',
        role: 'user',
        urgent: false,
        state: 'done',
        createdAt: t,
      };
      messages.set(message.id, message);
      streamReply();
      return { ...message };
    },
    async newChat() {},
    async searchHistory(q) {
      return [...messages.values()]
        .filter((m) => m.state === 'done' && m.kind !== 'chat' && containsText(m, q))
        .sort(byNewest)
        .map((m) => ({ ...m }));
    },
    async getSettings() {
      return { ...settings };
    },
    async setSettings(patch) {
      settings = applySettingsPatch(settings, SettingsPatch.parse(patch));
      return { ...settings };
    },
    async connectClaude(step) {
      await new Promise((r) => setTimeout(r, step === 'install' ? thinkMs : thinkMs / 3));
      const config = 'C:/Users/you/.claude';
      const mcp = 'C:/Users/you/AppData/Local/Programs/professor-clippy/resources/mcp/index.js';
      const hook = 'C:/Users/you/AppData/Local/Programs/professor-clippy/resources/hook/index.js';
      if (step === 'preview') {
        previewed = true;
        return {
          ok: true,
          warnings: [],
          log: [
            `Installing Professor Clippy wiring (Claude config dir: ${config})`,
            '[dry-run] would run: claude mcp remove --scope user clippy',
            `[dry-run] would run: claude mcp add --scope user clippy -- node ${mcp}`,
            `[dry-run] would add Stop + Notification + PermissionRequest hooks (node "${hook}" --professor-clippy) in ${config}/settings.json`,
            `[dry-run] would append the Professor Clippy hint in ${config}/CLAUDE.md`,
            'Dry run: nothing changed.',
          ],
        };
      }
      if (!previewed) return { ok: false, log: [], error: 'Show the changes first (preview), then install.', warnings: [] };
      return { ok: true, warnings: [], log: [`Installing Professor Clippy wiring (Claude config dir: ${config})`, 'Done.'] };
    },
    async telegramStatus() {
      return telegramStatus();
    },
    async setTelegramToken(token) {
      if (token !== null && !/^\d{3,}:[\w-]{20,}$/.test(token.trim())) {
        throw new Error("That doesn't look like a bot token. BotFather gives you one like 123456789:AAH…");
      }
      telegramToken = token !== null;
      return telegramStatus();
    },
    async telegramUnpair() {
      const { telegramChatId: _id, telegramChatName: _name, ...rest } = settings;
      settings = rest;
      return telegramStatus();
    },
    async telegramSendTest() {
      if (settings.telegramChatId === undefined) return { ok: false, error: 'No chat is paired yet: send /start with the code to your bot first.' };
      return { ok: true };
    },
    async hotkeyStatus() {
      return { accelerator: settings.tellHotkey, ok: true };
    },
    async listOrders() {
      return [...orders.values()].filter((o) => o.active).map((o) => ({ ...o }));
    },
    async addOrder(text) {
      const t = now();
      const order: StandingOrder = { id: ulid(t), text, active: true, createdAt: t };
      orders.set(order.id, order);
      return { ...order };
    },
    async cancelOrder(id) {
      const order = orders.get(id);
      if (!order) throw new Error(`No standing order ${id}`);
      orders.set(id, { ...order, active: false });
    },
    async listWatches() {
      return [...watches.values()].filter((w) => w.active).map((w) => ({ ...w }));
    },
    async addWatch({ project, event, nudge }) {
      const t = now();
      const watch: Watch = { id: ulid(t), ...(project !== undefined && { project }), event: event ?? 'finished', nudge, active: true, createdAt: t };
      watches.set(watch.id, watch);
      return { ...watch };
    },
    async cancelWatch(id) {
      const watch = watches.get(id);
      if (!watch) throw new Error(`No watch ${id}`);
      watches.set(id, { ...watch, active: false });
    },
    telegramStart(code, chat = { id: 123456789, firstName: 'You' }) {
      if (!telegramToken || settings.telegramChatId !== undefined || code.toUpperCase() !== pairingCode) return false;
      settings = { ...settings, telegramChatId: chat.id, telegramChatName: chat.firstName };
      return true;
    },
    on(event, cb) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set);
      const fn = cb as (payload: never) => void;
      set.add(fn);
      return () => {
        set.delete(fn);
      };
    },
    pushMessage(input) {
      const t = now();
      const message: Message = {
        kind: 'note',
        sender: 'claude-code',
        urgent: false,
        state: 'unread',
        createdAt: t,
        ...input,
        id: input.id ?? ulid(t),
      };
      messages.set(message.id, message);
      emit('message:new', { ...message });
      return { ...message };
    },
  };
}
