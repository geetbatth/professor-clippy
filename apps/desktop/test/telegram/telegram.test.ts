import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainReply } from '../../src/main/brain/brain';
import { Asks } from '../../src/main/core/asks';
import { Bus } from '../../src/main/core/bus';
import { Scheduler } from '../../src/main/core/scheduler';
import { Store } from '../../src/main/core/store';
import { SettingsStore } from '../../src/main/settings';
import { MAX_WRONG_CODES, PAIRING_KV_KEY, TelegramManager } from '../../src/main/telegram';
import { MISSED_NOTE } from '../../src/main/telegram/format';
import { OFFSET_KV_PREFIX } from '../../src/main/telegram/telegram';
import { PowerActions } from '../../src/main/power/actions';
import { alwaysMirror } from '../alwaysMirror';
import { actions as fakeActions, CHROME_PATH, fakeExecutor } from '../power/fakeExecutor';
import { FakeTelegram, fakeSecrets, guardFetch, waitFor } from './fakeTelegram';

const ME = 4242;

interface Ctx {
  fake: FakeTelegram;
  dir: string;
  bus: Bus;
  store: Store;
  scheduler: Scheduler;
  asks: Asks;
  settings: SettingsStore;
  manager: TelegramManager;
  asked: [string, unknown][];
  newChats: number;
  logs: string[];
  /** A new manager over the same store and settings (an app restart). */
  restart(): TelegramManager;
}

let guard: ReturnType<typeof guardFetch>;
let ctx: Ctx;
const cleanups: (() => Promise<void> | void)[] = [];

async function setup(
  options: { token?: boolean; chatId?: number; brain?: (text: string, store: Store) => BrainReply | Promise<BrainReply> } = {},
): Promise<Ctx> {
  const fake = await FakeTelegram.start();
  const dir = mkdtempSync(join(tmpdir(), 'clippy-telegram-'));
  const settings = await SettingsStore.load(join(dir, 'settings.json'), { secrets: fakeSecrets, log: () => {} });
  if (options.token !== false) await settings.setTelegramToken(fake.token);
  if (options.chatId !== undefined) await settings.update({ telegramChatId: options.chatId });
  const bus = new Bus();
  const store = new Store({ path: ':memory:', bus });
  const stopGate = alwaysMirror(bus, store);
  const scheduler = new Scheduler({ store, bus });
  const asks = new Asks({ store, bus });
  const asked: [string, unknown][] = [];
  const logs: string[] = [];
  const c = {} as Ctx;
  const brain = {
    async ask(text: string, opts?: unknown) {
      asked.push([text, opts]);
      return options.brain ? options.brain(text, store) : {};
    },
    newChat() {
      c.newChats++;
    },
  };
  const make = () => {
    const m = new TelegramManager({
      store,
      bus,
      asks,
      brain,
      settings,
      baseUrl: fake.baseUrl,
      backoffMinMs: 20,
      backoffMaxMs: 80,
      retryDelaysMs: [20, 40],
      typingIntervalMs: 30,
      log: (line) => logs.push(line),
    });
    settings.onChange(() => m.apply());
    m.apply();
    cleanups.push(() => m.stop());
    return m;
  };
  scheduler.start();
  Object.assign(c, { fake, dir, bus, store, scheduler, asks, settings, asked, newChats: 0, logs, restart: make });
  c.manager = make();
  cleanups.push(async () => {
    scheduler.stop();
    stopGate();
    await fake.close();
    store.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return c;
}

beforeEach(() => {
  guard = guardFetch();
});
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
  guard.restore();
});

const sends = () => ctx.fake.of('sendMessage');
const lastSend = () => sends().at(-1)!;

describe('Telegram: configuration', () => {
  it('makes no network calls at all without a token, whatever happens on the desk', async () => {
    ctx = await setup({ token: false });
    ctx.store.createMessage({ kind: 'note', body: 'hello', sender: 'agent' });
    ctx.asks.create({ question: 'Ship?', options: ['yes'], sender: 'agent' });
    ctx.scheduler.create({ body: 'stand-up', when: new Date(Date.now() - 1000).toISOString(), sender: 'agent' });
    await new Promise((r) => setTimeout(r, 100));
    expect(ctx.manager.active).toBe(false);
    expect(ctx.manager.status()).toEqual({ tokenSaved: false, state: 'off' });
    expect(ctx.fake.calls).toEqual([]);
    expect(guard.urls).toEqual([]);
  });

  it('starts when a token is saved, stops (aborting the long-poll) when it is removed', async () => {
    ctx = await setup({ token: false, chatId: ME });
    await ctx.manager.setToken(ctx.fake.token);
    expect(ctx.manager.active).toBe(true);
    await waitFor(() => ctx.fake.waitingPolls === 1, 3000, 'a long-poll');
    // A quick first poll (status known at once), then long-polls.
    expect(ctx.fake.of('getUpdates').map((p) => p.timeout)).toEqual(['0', '50']);
    expect(ctx.fake.of('getUpdates')[1]).toMatchObject({ allowed_updates: '["message","callback_query"]' });
    expect(ctx.manager.status()).toMatchObject({ tokenSaved: true, state: 'connected', botUsername: 'ProfessorClippyBot', chatId: ME });
    const before = ctx.fake.calls.length;
    await ctx.manager.setToken(null);
    expect(ctx.manager.active).toBe(false);
    await waitFor(() => ctx.fake.waitingPolls === 0, 3000, 'the poll to be aborted');
    ctx.store.createMessage({ kind: 'note', body: 'after', sender: 'agent' });
    await new Promise((r) => setTimeout(r, 60));
    expect(ctx.fake.calls.length).toBe(before);
    expect(ctx.manager.status()).toEqual({ tokenSaved: false, state: 'off', chatId: ME });
  });

  it('rejects something that is not a bot token', async () => {
    ctx = await setup({ token: false });
    await expect(ctx.manager.setToken('hello')).rejects.toThrow(/bot token/);
    expect(ctx.manager.active).toBe(false);
  });

  it('backs off on errors, says why (401) without the token, and recovers', async () => {
    ctx = await setup({ chatId: ME, token: false });
    ctx.fake.failNext('getMe', 401, { description: 'Unauthorized' });
    ctx.fake.failNext('getUpdates', 502, { description: `Bad Gateway at /bot${ctx.fake.token}/getUpdates` }, 2);
    await ctx.manager.setToken(ctx.fake.token);
    await waitFor(() => ctx.manager.status().state === 'connected', 3000, 'recovery');
    expect(ctx.logs.some((l) => /polling failed; .*rejected the bot token \(401 Unauthorized\)/.test(l))).toBe(true);
    const gaps = ctx.fake.calls.slice(0, 4).map((c, i, all) => (i ? c.at - all[i - 1]!.at : 0));
    expect(gaps[1]).toBeGreaterThanOrEqual(15); // 1st backoff (20 ms here; 1 s in the app)
    expect(gaps[3]).toBeGreaterThanOrEqual(35); // doubled: 40 ms (Windows timers are coarse, hence the slack)
    expect(ctx.logs.filter((l) => l.includes('polling failed'))).toHaveLength(3);
    for (const line of ctx.logs) expect(line).not.toContain(ctx.fake.token.split(':')[1]);
    expect(ctx.logs.some((l) => l.includes('/bot<token>/'))).toBe(true);
  });
});

describe('Telegram: polling', () => {
  it('handles each update once and persists the offset, so a restart neither reprocesses nor re-asks', async () => {
    ctx = await setup({ chatId: ME });
    const u = ctx.fake.text('first');
    await waitFor(() => ctx.asked.length === 1, 3000, 'the brain turn');
    await waitFor(() => ctx.store.getKv(`${OFFSET_KV_PREFIX}7000001`) === String(u.update_id + 1), 2000, 'the offset');
    await ctx.manager.stop();

    const again = ctx.restart();
    await waitFor(() => ctx.fake.waitingPolls === 1, 3000, 'the new long-poll');
    expect(ctx.fake.of('getUpdates').at(-1)).toMatchObject({ offset: String(u.update_id + 1) });
    // Telegram redelivers an update whose offset never got confirmed: still handled once.
    ctx.fake.push({ update_id: u.update_id, message: u.message! });
    ctx.fake.text('second');
    await waitFor(() => ctx.asked.length === 2, 3000, 'the second turn');
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.asked.map(([t]) => t)).toEqual(['first', 'second']);
    await again.stop();
  });

  it('ignores every other chat, groups included, and never answers them', async () => {
    ctx = await setup({ chatId: ME });
    ctx.fake.text('hi from a stranger', { chatId: 999 });
    ctx.fake.text('/help', { chatId: 999 });
    ctx.fake.text('hi from a group', { chatId: ME, type: 'group' });
    ctx.fake.text(`/start ${'X'.repeat(6)}`, { chatId: -100123, type: 'supergroup' });
    const ask = ctx.asks.create({ question: 'Ship?', options: ['yes', 'no'], sender: 'agent' });
    await waitFor(() => ctx.store.getMessage(ask.id)?.tgMsgId, 3000, 'the ask mirror');
    ctx.fake.tap(`a:${ask.id}:0`, ctx.store.getMessage(ask.id)!.tgMsgId!, { chatId: 999 });
    ctx.fake.tap(`a:${ask.id}:0`, ctx.store.getMessage(ask.id)!.tgMsgId!, { fromId: 999 });
    const last = ctx.fake.text('/notes'); // from me: proves the others were processed first
    await waitFor(() => ctx.store.getKv(`${OFFSET_KV_PREFIX}7000001`) === String(last.update_id + 1), 3000, 'all updates');
    await waitFor(() => sends().length === 2, 2000, 'the /notes answer');
    expect(sends().map((p) => p.chat_id)).toEqual([ME, ME]);
    expect(ctx.asked).toEqual([]);
    expect(ctx.fake.of('answerCallbackQuery')).toEqual([]);
    expect(ctx.asks.result(ask.id).status).toBe('pending');
  });

  it('pairs the first private /start with the right code, then talks only to that chat', async () => {
    ctx = await setup();
    const code = ctx.manager.status().pairingCode!;
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    expect(ctx.manager.pairingCode()).toBe(code); // stable until used
    ctx.fake.text('/start WRONG1', { chatId: 555 });
    ctx.fake.text(`/start ${code}`, { chatId: -100, type: 'group' });
    ctx.fake.text('hello?', { chatId: 555 });
    ctx.fake.text(`/start ${code.toLowerCase()}`, { chatId: ME, firstName: 'Geet' });
    await waitFor(() => ctx.settings.get().telegramChatId === ME, 3000, 'pairing');
    expect(ctx.settings.get().telegramChatName).toBe('Geet');
    await waitFor(() => sends().length === 1, 2000, 'the hello');
    expect(lastSend()).toMatchObject({ chat_id: ME, parse_mode: 'HTML' });
    expect(String(lastSend().text)).toMatch(/^✅ Paired! Hello Geet\.\n\n📎 <b>Professor Clippy<\/b>/);
    expect(ctx.manager.status()).toMatchObject({ chatId: ME, chatName: 'Geet' });
    expect(ctx.manager.status()).not.toHaveProperty('pairingCode');
    expect(ctx.store.getKv(PAIRING_KV_KEY)).toBeUndefined();

    ctx.fake.text(`/start ${code}`, { chatId: 556 }); // too late: already paired
    ctx.fake.text('hi', { chatId: ME });
    await waitFor(() => ctx.asked.length === 1, 3000, 'chat from the paired chat');
    expect(sends().every((p) => p.chat_id === ME)).toBe(true);

    const unpaired = await ctx.manager.unpair();
    expect(unpaired.pairingCode).toMatch(/^[A-Z2-9]{6}$/);
    expect(unpaired.pairingCode).not.toBe(code);
    expect(ctx.settings.get()).not.toHaveProperty('telegramChatId');
  });

  it('counts wrong codes per chat: a guesser is locked out, the code never changes, others can still pair', async () => {
    ctx = await setup();
    const code = ctx.manager.pairingCode()!;
    // Many strangers, a few guesses each: nothing changes.
    for (let i = 0; i < 20; i++) ctx.fake.text(`/start ZZZZZ${i}`, { chatId: 600 + i });
    // One chat guesses MAX_WRONG_CODES times, then sends the right code: still refused.
    for (let i = 0; i < MAX_WRONG_CODES; i++) ctx.fake.text(`/start YYYYY${i}`, { chatId: 666 });
    const last = ctx.fake.text(`/start ${code}`, { chatId: 666 });
    await waitFor(() => ctx.store.getKv(`${OFFSET_KV_PREFIX}7000001`) === String(last.update_id + 1), 3000, 'all updates');
    expect(ctx.settings.get().telegramChatId).toBeUndefined();
    expect(ctx.manager.pairingCode()).toBe(code);
    expect(ctx.logs.some((l) => /that chat may not pair any more/.test(l))).toBe(true);
    // The user's own chat pairs with the same code.
    ctx.fake.text(`/start ${code}`, { chatId: ME });
    await waitFor(() => ctx.settings.get().telegramChatId === ME, 3000, 'pairing');
    await waitFor(() => sends().length === 1, 3000, 'the hello');
    expect(sends().map((p) => p.chat_id)).toEqual([ME]);
  });

  it('a pairing set directly (chat id typed in) works without /start', async () => {
    ctx = await setup();
    await ctx.settings.update({ telegramChatId: ME });
    ctx.store.createMessage({ kind: 'note', body: 'hi', sender: 'agent' });
    await waitFor(() => sends().length === 1, 3000, 'the note');
    expect(lastSend().chat_id).toBe(ME);
  });
});

describe('Telegram: the 4096-character limit holds for every part', () => {
  it('a note with a 5000-character title (and sender) is still delivered, within the limit', async () => {
    ctx = await setup({ chatId: ME });
    const m = ctx.store.createMessage({ kind: 'note', title: '<'.repeat(5000), body: 'b&'.repeat(3000), sender: 's'.repeat(5000), project: 'p'.repeat(5000) });
    await waitFor(() => ctx.store.getMessage(m.id)?.tgMsgId, 3000, 'the note');
    const text = String(lastSend().text);
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toMatch(/^📝 <b>(&lt;)+…<\/b>\n/);
    expect(text).toMatch(/…more on desktop\n\n<i>— s+… · p+…<\/i>$/);
  });

  it('an edited ask with a 5000-character answer, and the already-answered reply quoting it, fit', async () => {
    ctx = await setup({ chatId: ME });
    const ask = ctx.asks.create({ question: 'Q?'.repeat(1500), options: ['a'], sender: 'agent' });
    const tgMsgId = await waitFor(() => ctx.store.getMessage(ask.id)?.tgMsgId, 3000, 'the ask');
    ctx.asks.answer(ask.id, '&'.repeat(5000), 'desk');
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the edit');
    const edit = String(ctx.fake.of('editMessageText')[0]!.text);
    expect(edit.length).toBeLessThanOrEqual(4096);
    expect(edit).toMatch(/✅ Answered: (&amp;)+… <i>\(on the desk\)<\/i>$/);
    ctx.fake.text('my answer', { replyTo: tgMsgId });
    await waitFor(() => sends().length === 2, 3000, 'the already-answered reply');
    const reply = String(lastSend().text);
    expect(reply.length).toBeLessThanOrEqual(4096);
    expect(reply).toMatch(/^📎 That question was already answered \(via desk\): “(&amp;)+…”\.$/);
  });
});

describe('Telegram: mirroring', () => {
  it('sends notes as escaped HTML and stores the message id', async () => {
    ctx = await setup({ chatId: ME });
    const m = ctx.store.createMessage({
      kind: 'note',
      title: 'Build <done>',
      body: 'if (a < b && c > d) { "ok" }',
      sender: 'claude-code',
      project: 'web&api',
      urgent: true,
    });
    await waitFor(() => ctx.store.getMessage(m.id)?.tgMsgId, 3000, 'the mirror');
    expect(lastSend()).toMatchObject({ chat_id: ME, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
    expect(lastSend().text).toBe(
      '🔴 📝 <b>Build &lt;done&gt;</b>\nif (a &lt; b &amp;&amp; c &gt; d) { &quot;ok&quot; }\n\n<i>— claude-code · web&amp;api</i>',
    );
    expect(lastSend()).not.toHaveProperty('reply_markup');
  });

  it('does not mirror desk chat, and skips a note dismissed before it went out', async () => {
    ctx = await setup({ chatId: ME });
    ctx.store.createMessage({ kind: 'chat', role: 'user', sender: 'user', body: 'desk chat', state: 'done' });
    const gone = ctx.store.createMessage({ kind: 'note', body: 'gone', sender: 'agent' });
    ctx.store.markDone(gone.id);
    ctx.store.createMessage({ kind: 'note', body: 'kept', sender: 'agent' });
    await waitFor(() => sends().length === 1, 3000, 'one send');
    await ctx.manager.channel!.idle();
    expect(ctx.fake.sentTexts).toEqual(['📝 kept\n\n<i>— agent</i>']);
  });

  it('sends asks with one button per option', async () => {
    ctx = await setup({ chatId: ME });
    const ask = ctx.asks.create({ question: 'Deploy now?', options: ['Yes', 'Not yet'], sender: 'agent', project: 'shop' });
    await waitFor(() => ctx.store.getMessage(ask.id)?.tgMsgId, 3000, 'the ask');
    expect(String(lastSend().text)).toMatch(/^❓ Deploy now\?\n\n<i>— agent · shop<\/i>\n<i>Tap an answer/);
    expect(lastSend().reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Yes', callback_data: `a:${ask.id}:0` }], [{ text: 'Not yet', callback_data: `a:${ask.id}:1` }]],
    });
  });

  it('sends reminders when the scheduler fires them (no Worker does it for Telegram)', async () => {
    ctx = await setup({ chatId: ME });
    ctx.scheduler.create({ body: 'Stand-up', when: new Date(Date.now() - 1000).toISOString(), sender: 'agent' });
    await waitFor(() => sends().length === 1, 3000, 'the reminder');
    expect(lastSend().text).toBe('⏰ Stand-up\n\n<i>— agent</i>');
    const fired = ctx.store.listMessages({ kind: 'reminder' })[0]!;
    await waitFor(() => ctx.store.getMessage(fired.id)?.tgMsgId, 2000, 'its id');
  });

  it('sends reminders missed while the PC was off as one message, marked missed', async () => {
    ctx = await setup({ chatId: ME });
    await waitFor(() => ctx.fake.waitingPolls === 1, 3000, 'connected');
    const now = Date.now();
    for (const [i, body] of ['Water the plants', 'Call <Mum>'].entries()) {
      ctx.store.insertReminder({ id: ctx.store.newId(), body, sender: 'agent', dueAt: now - 3_600_000 + i, active: true, createdAt: now - 7_200_000, startAt: now - 3_600_000 + i });
    }
    ctx.scheduler.onResume(); // the PC wakes: both fire at once as missed
    await waitFor(() => sends().length === 1, 3000, 'the missed batch');
    await new Promise((r) => setTimeout(r, 50));
    expect(sends()).toHaveLength(1);
    expect(lastSend().text).toBe(
      `⏰ <b>2 reminders</b> <i>${MISSED_NOTE}</i>\n\n• Water the plants\n<i>— agent</i>\n\n• Call &lt;Mum&gt;\n<i>— agent</i>`,
    );
    await waitFor(() => ctx.store.listMessages({ kind: 'reminder' }).every((m) => m.tgMsgId !== undefined), 2000, 'ids');
    expect(new Set(ctx.store.listMessages({ kind: 'reminder' }).map((m) => m.tgMsgId)).size).toBe(1);
  });

  it('a single missed reminder carries the missed note', async () => {
    ctx = await setup({ chatId: ME });
    const now = Date.now();
    ctx.store.insertReminder({ id: ctx.store.newId(), body: 'Pay rent', sender: 'agent', dueAt: now - 3_600_000, active: true, createdAt: now - 7_200_000, startAt: now - 3_600_000 });
    ctx.scheduler.onResume();
    await waitFor(() => sends().length === 1, 3000, 'the missed reminder');
    expect(lastSend().text).toBe(`⏰ Pay rent\n\n<i>— agent</i>\n<i>${MISSED_NOTE}</i>`);
  });

  it('waits out a 429 retry_after, then sends (in order, once)', async () => {
    ctx = await setup({ chatId: ME });
    ctx.fake.failNext('sendMessage', 429, { description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    ctx.store.createMessage({ kind: 'note', body: 'one', sender: 'agent' });
    ctx.store.createMessage({ kind: 'note', body: 'two', sender: 'agent' });
    await waitFor(() => sends().length === 3, 4000, 'the retry and the next send');
    const at = ctx.fake.calls.filter((c) => c.method === 'sendMessage').map((c) => c.at);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(950);
    expect(ctx.fake.sentTexts.map((t) => t.split('\n')[0])).toEqual(['📝 one', '📝 one', '📝 two']);
    expect(ctx.logs.some((l) => /retrying in 1 s/.test(l))).toBe(true);
  });

  it('gives up after the bounded retries, and at once on a permanent error', async () => {
    ctx = await setup({ chatId: ME });
    ctx.fake.failNext('sendMessage', 500, {}, 3);
    const a = ctx.store.createMessage({ kind: 'note', body: 'flaky', sender: 'agent' });
    await waitFor(() => ctx.logs.some((l) => /send .* failed after 3 attempt\(s\); giving up/.test(l)), 3000, 'giving up');
    ctx.fake.failNext('sendMessage', 403, { description: 'Forbidden: bot was blocked by the user' });
    ctx.store.createMessage({ kind: 'note', body: 'blocked', sender: 'agent' });
    await waitFor(() => ctx.logs.some((l) => /failed; giving up: .*blocked/.test(l)), 3000, 'permanent');
    expect(sends()).toHaveLength(4);
    expect(ctx.store.getMessage(a.id)?.tgMsgId).toBeUndefined();
  });
});

describe('Telegram: answering asks', () => {
  async function mirroredAsk(options?: string[]) {
    const ask = ctx.asks.create({ question: 'Ship it?', sender: 'agent', ...(options && { options }) });
    const tgMsgId = await waitFor(() => ctx.store.getMessage(ask.id)?.tgMsgId, 3000, 'the ask mirror');
    return { ask, tgMsgId };
  }

  it('a button tap answers the ask (via telegram), acknowledges it and edits the message', async () => {
    ctx = await setup({ chatId: ME });
    const { ask, tgMsgId } = await mirroredAsk(['Yes', 'No']);
    const waiting = ctx.asks.wait(ask.id, 5000);
    ctx.fake.tap(`a:${ask.id}:1`, tgMsgId);
    expect(await waiting).toEqual({ id: ask.id, status: 'answered', answer: 'No', answeredVia: 'telegram' });
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the edit');
    expect(ctx.fake.of('answerCallbackQuery')[0]).toMatchObject({ text: '✅ No' });
    const edit = ctx.fake.of('editMessageText')[0]!;
    expect(edit).toMatchObject({ chat_id: ME, message_id: tgMsgId, reply_markup: { inline_keyboard: [] } });
    expect(String(edit.text)).toMatch(/^❓ Ship it\?\n\n<i>— agent<\/i>\n\n✅ Answered: No$/);

    // A second tap: already answered; says so, nothing changes.
    ctx.fake.tap(`a:${ask.id}:0`, tgMsgId);
    await waitFor(() => ctx.fake.of('answerCallbackQuery').length === 2, 3000, 'the second ack');
    expect(ctx.fake.of('answerCallbackQuery')[1]).toMatchObject({ text: 'Already answered (via telegram): No' });
    expect(ctx.asks.result(ask.id).answer).toBe('No');
  });

  it('a text using Telegram reply on the ask answers it', async () => {
    ctx = await setup({ chatId: ME });
    const { ask, tgMsgId } = await mirroredAsk();
    expect(String(lastSend().text)).toMatch(/Reply to this message to answer/);
    ctx.fake.text('Only after lunch', { replyTo: tgMsgId });
    await waitFor(() => ctx.asks.result(ask.id).status === 'answered', 3000, 'the answer');
    expect(ctx.asks.result(ask.id)).toMatchObject({ answer: 'Only after lunch', answeredVia: 'telegram' });
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the edit');
    expect(ctx.asked).toEqual([]); // an answer, not chat

    ctx.fake.text('Actually no', { replyTo: tgMsgId });
    await waitFor(() => sends().length === 2, 3000, 'the already-answered note');
    expect(lastSend().text).toBe('📎 That question was already answered (via telegram): “Only after lunch”.');
  });

  it('an answer that lands while the ask is still being sent still edits it', async () => {
    ctx = await setup({ chatId: ME });
    await waitFor(() => ctx.fake.waitingPolls === 1, 3000, 'connected');
    ctx.fake.delayNext('sendMessage', 300);
    const ask = ctx.asks.create({ question: 'Quick?', options: ['y'], sender: 'agent' });
    await waitFor(() => sends().length === 1, 3000, 'the send in flight');
    expect(ctx.store.getMessage(ask.id)?.tgMsgId).toBeUndefined();
    ctx.asks.answer(ask.id, 'y', 'desk');
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the edit');
    expect(ctx.fake.of('editMessageText')[0]).toMatchObject({ message_id: ctx.store.getMessage(ask.id)?.tgMsgId });
  });

  it('an answer on the desk edits the Telegram copy (best effort)', async () => {
    ctx = await setup({ chatId: ME });
    const { ask, tgMsgId } = await mirroredAsk(['A', 'B']);
    ctx.asks.answer(ask.id, 'A', 'desk');
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the edit');
    expect(ctx.fake.of('editMessageText')[0]).toMatchObject({ message_id: tgMsgId });
    expect(String(ctx.fake.of('editMessageText')[0]!.text)).toMatch(/✅ Answered: A <i>\(on the desk\)<\/i>$/);
    // An ask answered before its mirror went out is never sent.
    const late = ctx.asks.create({ question: 'Too late?', sender: 'agent' });
    ctx.asks.answer(late.id, 'yes', 'desk');
    await ctx.manager.channel!.idle();
    await new Promise((r) => setTimeout(r, 50));
    expect(ctx.fake.sentTexts.filter((t) => t.includes('Too late'))).toEqual([]);
  });
});

describe('Telegram: restart questions (power actions)', () => {
  /** PowerActions over this test's store, with a fake executor: nothing real is touched. */
  function power() {
    const fake = fakeExecutor();
    const actionsService = new PowerActions({ store: ctx.store, bus: ctx.bus, asks: ctx.asks, allowed: () => true, executor: fake });
    cleanups.push(() => actionsService.dispose());
    return { fake, power: actionsService };
  }

  it('shows Restart / Cancel buttons; a tap on Restart answers via telegram and runs it', async () => {
    ctx = await setup({ chatId: ME });
    const { fake, power: p } = power();
    const { id } = await p.requestRestartApp('chrome');
    const tgMsgId = await waitFor(() => ctx.store.getMessage(id)?.tgMsgId, 3000, 'the question');
    expect(String(lastSend().text)).toMatch(/^🔴 ❓ Restart Google Chrome \(chrome\.exe, 3 processes\)\?/);
    expect(lastSend().reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Restart', callback_data: `a:${id}:0` }], [{ text: 'Cancel', callback_data: `a:${id}:1` }]],
    });
    ctx.fake.tap(`a:${id}:0`, tgMsgId);
    await waitFor(() => ctx.asks.result(id).status === 'answered', 3000, 'the answer');
    expect(ctx.asks.result(id)).toMatchObject({ answer: 'Restart', answeredVia: 'telegram' });
    await p.settled();
    expect(fakeActions(fake)).toContain(`launch ${CHROME_PATH} | --profile-directory=Default`);
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the buttons removed');
  });

  it('a typed reply (yes) to the question answers it via telegram too', async () => {
    ctx = await setup({ chatId: ME });
    const { fake, power: p } = power();
    const { id } = await p.requestRestartPc();
    const tgMsgId = await waitFor(() => ctx.store.getMessage(id)?.tgMsgId, 3000, 'the question');
    ctx.fake.text('yes', { replyTo: tgMsgId });
    await waitFor(() => ctx.asks.result(id).status === 'answered', 3000, 'the answer');
    expect(ctx.asks.result(id)).toMatchObject({ answer: 'yes', answeredVia: 'telegram' });
    await p.settled();
    expect(fakeActions(fake)).toEqual(['shutdown /r /t 60 /c Professor Clippy is restarting your PC because you asked him to.']);
    expect(ctx.asked).toEqual([]); // an answer, not a brain turn
  });

  it('a leftover expired on start loses its buttons in Telegram', async () => {
    ctx = await setup({ chatId: ME });
    const { fake, power: p } = power();
    const { id } = await p.requestRestartPc();
    await waitFor(() => ctx.store.getMessage(id)?.tgMsgId, 3000, 'the question');
    p.expireLeftovers();
    await waitFor(() => ctx.fake.of('editMessageText').length === 1, 3000, 'the edit');
    expect(ctx.fake.of('editMessageText')[0]).toMatchObject({ reply_markup: { inline_keyboard: [] } });
    expect(String(ctx.fake.of('editMessageText')[0]!.text)).toMatch(/Answered: Expired/);
    expect(fakeActions(fake)).toEqual([]);
  });
});

describe('Telegram: changing bot or chat', () => {
  const TOKEN2 = '7000002:AASecondFakeBotTokenForTests_xyz';

  it('re-pairing to another chat forgets the old message ids; the same chat again keeps them', async () => {
    ctx = await setup({ chatId: ME });
    const ask = ctx.asks.create({ question: 'Old?', sender: 'agent' });
    const old = await waitFor(() => ctx.store.getMessage(ask.id)?.tgMsgId, 3000, 'the ask');
    await ctx.manager.unpair();
    await ctx.settings.update({ telegramChatId: ME }); // the same chat again
    expect(ctx.store.getMessage(ask.id)?.tgMsgId).toBe(old);
    await ctx.manager.unpair();
    await ctx.settings.update({ telegramChatId: 777 });
    expect(ctx.store.getMessage(ask.id)?.tgMsgId).toBeUndefined();
    // A reply in the new chat to that message id is chat, not an answer.
    ctx.fake.text('yes', { chatId: 777, replyTo: old });
    await waitFor(() => ctx.asked.length === 1, 3000, 'chat');
    expect(ctx.asks.result(ask.id).status).toBe('pending');
    expect(ctx.asked[0]![0]).toBe('yes');
  });

  it('a new token keeps queued sends (they go out with the new bot); the same token saved again changes nothing', async () => {
    ctx = await setup({ chatId: ME });
    ctx.fake.addToken(TOKEN2);
    await waitFor(() => ctx.fake.waitingPolls === 1, 3000, 'connected');
    const getMes = ctx.fake.of('getMe').length;
    await ctx.manager.setToken(ctx.fake.token); // re-saved: new ciphertext, same token
    await new Promise((r) => setTimeout(r, 80));
    expect(ctx.fake.of('getMe').length).toBe(getMes);
    expect(ctx.fake.waitingPolls).toBe(1);

    // The first try is told to wait 1 s: the send sits in the queue, waiting to retry, while the token changes.
    ctx.fake.failNext('sendMessage', 429, { parameters: { retry_after: 1 } });
    const m = ctx.store.createMessage({ kind: 'note', body: 'carried over', sender: 'agent' });
    await waitFor(() => sends().length === 1, 3000, 'the failed try');
    await ctx.manager.setToken(TOKEN2);
    await waitFor(() => ctx.store.getMessage(m.id)?.tgMsgId, 3000, 'the retried send');
    const tries = ctx.fake.calls.filter((c) => c.method === 'sendMessage');
    expect(tries.map((c) => c.token)).toEqual([ctx.fake.token, TOKEN2]);
    await waitFor(() => ctx.fake.calls.some((c) => c.token === TOKEN2 && c.method === 'getUpdates'), 3000, 'polling the new bot');
    expect(ctx.manager.status()).toMatchObject({ tokenSaved: true });
    // Its id came from the new bot, after the switch, so it is kept.
    expect(ctx.store.getMessage(m.id)?.tgMsgId).toBeDefined();
  });

  it('a new bot forgets message ids from the old one', async () => {
    ctx = await setup({ chatId: ME });
    ctx.fake.addToken(TOKEN2);
    const m = ctx.store.createMessage({ kind: 'note', body: 'old bot', sender: 'agent' });
    await waitFor(() => ctx.store.getMessage(m.id)?.tgMsgId, 3000, 'sent');
    await ctx.manager.setToken(TOKEN2);
    expect(ctx.store.getMessage(m.id)?.tgMsgId).toBeUndefined();
  });

  it('waits out a 429 retry_after from getUpdates', async () => {
    ctx = await setup({ chatId: ME, token: false });
    ctx.fake.failNext('getUpdates', 429, { description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
    await ctx.manager.setToken(ctx.fake.token);
    await waitFor(() => ctx.fake.of('getUpdates').length >= 2, 4000, 'the second poll');
    const polls = ctx.fake.calls.filter((c) => c.method === 'getUpdates').map((c) => c.at);
    expect(polls[1]! - polls[0]!).toBeGreaterThanOrEqual(950); // not the 20 ms backoff
    expect(ctx.logs.some((l) => /polling failed; retrying in 1 s/.test(l))).toBe(true);
  });
});

describe('Telegram: chat', () => {
  const reply = (body: string) => (_text: string, store: Store): BrainReply => ({
    message: store.createMessage({ kind: 'chat', role: 'clippy', sender: 'clippy', body, state: 'done' }),
  });

  it('turns text into a brain turn on the telegram channel, shows typing, and sends the reply', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    ctx = await setup({
      chatId: ME,
      brain: async (text, store) => {
        await gate;
        return reply(`You said <${text}>`)(text, store);
      },
    });
    ctx.fake.text('What is up?');
    await waitFor(() => ctx.fake.of('sendChatAction').length >= 2, 3000, 'typing, repeated');
    expect(ctx.fake.of('sendChatAction')[0]).toEqual({ chat_id: ME, action: 'typing' });
    release();
    await waitFor(() => sends().length === 1, 3000, 'the reply');
    expect(lastSend().text).toBe('You said &lt;What is up?&gt;');
    const typing = ctx.fake.of('sendChatAction').length;
    await new Promise((r) => setTimeout(r, 80));
    expect(ctx.fake.of('sendChatAction').length).toBe(typing); // stopped
    expect(ctx.asked).toEqual([['What is up?', { channel: 'telegram' }]]);
    const chat = ctx.store.listMessages({ kind: 'chat' });
    expect(chat.map((m) => [m.role, m.body])).toEqual([
      ['clippy', 'You said <What is up?>'],
      ['user', 'What is up?'],
    ]);
    await waitFor(() => ctx.store.listMessages({ kind: 'chat' })[0]!.tgMsgId, 2000, 'the reply id');

    // Replying to Clippy's reply gives the brain the context.
    ctx.fake.text('Tell me more', { replyTo: ctx.store.listMessages({ kind: 'chat' })[0]!.tgMsgId! });
    await waitFor(() => ctx.asked.length === 2, 3000, 'the second turn');
    expect(ctx.asked[1]![0]).toBe('(Replying to your earlier message: “You said <What is up?>”)\nTell me more');
  });

  it('sends a brain error back', async () => {
    ctx = await setup({ chatId: ME, brain: () => ({ error: "Claude Code isn't logged in." }) });
    ctx.fake.text('hi');
    await waitFor(() => sends().length === 1, 3000, 'the error');
    expect(lastSend().text).toBe("📎 Claude Code isn't logged in.");
  });

  it('splits a long reply into Telegram-sized messages', async () => {
    const long = `${'word '.repeat(1000)}\n${'more '.repeat(800)}`; // ~9000 chars
    ctx = await setup({ chatId: ME, brain: reply(long) });
    ctx.fake.text('essay please');
    await waitFor(() => sends().length === 3, 3000, 'three parts');
    for (const t of ctx.fake.sentTexts) expect(t.length).toBeLessThanOrEqual(4096);
    expect(ctx.fake.sentTexts.join(' ').replace(/\s+/g, ' ').trim()).toBe(long.replace(/\s+/g, ' ').trim());
  });

  it('answers /help, /notes and /new, and tells the user it only reads text', async () => {
    ctx = await setup({ chatId: ME });
    ctx.store.createMessage({ kind: 'note', title: 'Deploy done', body: 'x', sender: 'ci', urgent: true });
    ctx.asks.create({ question: 'Merge <the> PR?', sender: 'agent' });
    await waitFor(() => sends().length === 2, 3000, 'the mirrors');
    ctx.fake.text('/help@ProfessorClippyBot');
    ctx.fake.text('/notes');
    ctx.fake.text('/new');
    ctx.fake.push({ message: { message_id: 99, chat: { id: ME, type: 'private' }, from: { id: ME } } }); // a sticker, say
    ctx.fake.text('/frobnicate');
    await waitFor(() => sends().length === 7, 3000, 'five answers');
    const [help, notes, fresh, textOnly, unknown] = ctx.fake.sentTexts.slice(2);
    expect(help).toMatch(/^📎 <b>Professor Clippy<\/b> on Telegram/);
    expect(notes).toBe('<b>2 unread</b>\n❓ Merge &lt;the&gt; PR? <i>— agent</i>\n🔴 📝 Deploy done <i>— ci</i>');
    expect(fresh).toMatch(/New chat started/);
    expect(ctx.newChats).toBe(1);
    expect(textOnly).toMatch(/only read text/);
    expect(unknown).toMatch(/^I don’t know \/frobnicate\./);
    expect(ctx.asked).toEqual([]);
  });

  it('Send test reports success, and failure with the reason', async () => {
    ctx = await setup({ chatId: ME });
    expect(await ctx.manager.sendTest()).toEqual({ ok: true });
    expect(String(lastSend().text)).toMatch(/Test from Professor Clippy/);
    ctx.fake.failNext('sendMessage', 400, { description: 'Bad Request: chat not found' });
    expect(await ctx.manager.sendTest()).toEqual({ ok: false, error: 'Telegram sendMessage failed (400): Bad Request: chat not found' });
    await ctx.manager.unpair();
    expect(await ctx.manager.sendTest()).toMatchObject({ ok: false, error: expect.stringMatching(/No chat is paired/) });
  });
});
