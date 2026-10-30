import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SETTINGS,
  type Message,
  type RelayReminderPut,
  type RelaySendRequest,
  type RelaySendResponse,
  type WorkerToPc,
} from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrainReply } from '../../src/main/brain/brain';
import { Asks } from '../../src/main/core/asks';
import { Bus } from '../../src/main/core/bus';
import { Scheduler } from '../../src/main/core/scheduler';
import { Store } from '../../src/main/core/store';
import { RelayManager, relayConfig } from '../../src/main/relay';
import { formatForWhatsApp, normalizeWorkerUrl, Relay, SEEN_KV_KEY, SYNCED_KV_PREFIX } from '../../src/main/relay/relay';
import { RelayHttpError, type FrameHandler, type RelayTransport } from '../../src/main/relay/relayClient';
import { alwaysMirror } from '../alwaysMirror';
import { FakeWorker, waitFor } from './fakeWorker';

/** In-memory transport: records calls; `failures` makes the next calls throw. */
class FakeTransport implements RelayTransport {
  calls: (['send', RelaySendRequest] | ['put', string, RelayReminderPut] | ['delete', string])[] = [];
  failures: Error[] = [];
  onFrame: FrameHandler | undefined;
  started = 0;
  stopped = 0;
  reconnects = 0;
  #wa = 1;
  start(onFrame: FrameHandler) {
    this.started++;
    this.onFrame = onFrame;
  }
  stop() {
    this.stopped++;
  }
  reconnect() {
    this.reconnects++;
  }
  #maybeFail() {
    const err = this.failures.shift();
    if (err) throw err;
  }
  async send(request: RelaySendRequest): Promise<RelaySendResponse> {
    this.calls.push(['send', request]);
    this.#maybeFail();
    return { waId: `wamid.${this.#wa++}`, mode: 'freeform' };
  }
  async putReminder(id: string, body: RelayReminderPut) {
    this.calls.push(['put', id, body]);
    this.#maybeFail();
  }
  async deleteReminder(id: string, _signal?: AbortSignal) {
    this.calls.push(['delete', id]);
    this.#maybeFail();
  }
  get sends() {
    return this.calls.filter((c) => c[0] === 'send').map((c) => c[1] as RelaySendRequest);
  }
}

function setup(brainReply: (text: string) => BrainReply | Promise<BrainReply> = () => ({}), retryDelaysMs = [10, 20]) {
  const bus = new Bus();
  const store = new Store({ path: ':memory:', bus });
  alwaysMirror(bus, store);
  const scheduler = new Scheduler({ store, bus });
  const asks = new Asks({ store, bus });
  const transport = new FakeTransport();
  const asked: [string, unknown][] = [];
  const brain = {
    async ask(text: string, opts?: unknown) {
      asked.push([text, opts]);
      return brainReply(text);
    },
  };
  const logs: string[] = [];
  const relay = new Relay({
    store,
    bus,
    scheduler,
    asks,
    brain,
    transport,
    timeZone: () => 'America/Vancouver',
    retryDelaysMs,
    log: (m) => logs.push(m),
  });
  scheduler.start();
  relay.start();
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 5));
      await relay.idle();
    }
  };
  return { bus, store, scheduler, asks, transport, relay, asked, logs, settle };
}

const inbound = (id: string, text: string, contextWaId?: string): WorkerToPc => ({
  type: 'inbound',
  id,
  text,
  ts: 1,
  ...(contextWaId && { contextWaId }),
});

describe('Relay', () => {
  let ctx: ReturnType<typeof setup>;
  afterEach(() => {
    ctx.relay.stop();
    ctx.scheduler.stop();
    ctx.store.close();
  });

  describe('outbound', () => {
    beforeEach(() => {
      ctx = setup();
    });

    it('mirrors notes and asks verbatim with a header, and stores the waId', async () => {
      const { store, asks, transport, settle } = ctx;
      const note = store.createMessage({ kind: 'note', title: 'CI', body: 'All 482 tests passed.', sender: 'claude-code', project: 'shop', urgent: true });
      const ask = asks.create({ question: 'Deploy to prod?', options: ['yes', 'no'], sender: 'codex', project: 'api' });
      await settle();
      expect(transport.sends).toEqual([
        { text: '🚨 📝 CI\nAll 482 tests passed.\n\n— claude-code · shop', kind: 'note', urgent: true },
        { text: '❓ Deploy to prod?\nOptions: yes / no\n\n— codex · api\n(Quote-reply to this message to answer.)', kind: 'ask', urgent: false },
      ]);
      expect(store.getMessage(note.id)?.waId).toBe('wamid.1');
      expect(store.getMessage(ask.id)?.waId).toBe('wamid.2');
    });

    it('never sends reminder or chat messages itself', async () => {
      const { store, scheduler, transport, settle } = ctx;
      scheduler.create({ body: 'stretch', when: new Date(Date.now() - 1000).toISOString(), sender: 'agent' });
      await new Promise((r) => setTimeout(r, 20)); // the scheduler fires the overdue reminder
      expect(store.listMessages({ kind: 'reminder' })).toHaveLength(1);
      store.createMessage({ kind: 'chat', role: 'user', body: 'hi', sender: 'user', state: 'done' });
      await settle();
      expect(transport.sends).toEqual([]);
    });

    it('PUTs a created reminder once with tz, DELETEs on cancel, and never re-syncs', async () => {
      const { scheduler, transport, relay, settle } = ctx;
      const due = Date.now() + 3_600_000;
      const daily = scheduler.create({ body: 'standup', when: new Date(due).toISOString(), rrule: 'FREQ=DAILY', sender: 'agent' });
      const once = scheduler.create({ body: 'call mum', when: new Date(due).toISOString(), sender: 'agent' });
      await settle();
      scheduler.cancel(once.id);
      await settle();
      expect(transport.calls).toEqual([
        ['put', daily.id, { body: 'standup', dueAt: daily.dueAt, rrule: 'FREQ=DAILY', startAt: due, tz: 'America/Vancouver' }],
        ['put', once.id, { body: 'call mum', dueAt: once.dueAt, tz: 'America/Vancouver' }],
        ['delete', once.id],
      ]);
      // A restart of the relay (reconnect) sends nothing.
      relay.stop();
      relay.start();
      await settle();
      expect(transport.calls).toHaveLength(3);
    });

    it("sends a recurring reminder's original start, so the Worker counts COUNT from the same anchor", async () => {
      const { scheduler, transport, settle } = ctx;
      // Started 26 h ago, 3 times daily: the 1st and 2nd are past, only the 3rd is still due.
      const start = Math.floor((Date.now() - 26 * 3_600_000) / 60_000) * 60_000;
      const r = scheduler.create({ body: 'pill', when: new Date(start).toISOString(), rrule: 'FREQ=DAILY;COUNT=3', sender: 'agent' });
      await settle();
      expect(r.dueAt).toBeGreaterThan(Date.now());
      expect(transport.calls).toEqual([
        ['put', r.id, { body: 'pill', dueAt: r.dueAt, rrule: 'FREQ=DAILY;COUNT=3', startAt: start, tz: 'America/Vancouver' }],
      ]);
    });

    it('retries failed sends with backoff, gives up on permanent errors', async () => {
      const { store, transport, logs, settle } = ctx;
      transport.failures.push(new RelayHttpError(502, 'meta down'), new Error('offline'));
      const m = store.createMessage({ kind: 'note', body: 'retry me', sender: 'a' });
      await waitFor(() => store.getMessage(m.id)?.waId !== undefined, 2000, 'retried send');
      expect(transport.sends).toHaveLength(3);

      transport.failures.push(new RelayHttpError(400, 'bad body'));
      const bad = store.createMessage({ kind: 'note', body: 'rejected', sender: 'a' });
      await settle();
      await new Promise((r) => setTimeout(r, 50));
      expect(store.getMessage(bad.id)?.waId).toBeUndefined();
      expect(transport.sends).toHaveLength(4);
      expect(logs.some((l) => l.includes('giving up'))).toBe(true);
    });

    it('does not retry a send once the message no longer needs it, nor re-PUT a cancelled reminder', async () => {
      ctx.relay.stop();
      ctx.scheduler.stop();
      ctx.store.close();
      ctx = setup(undefined, [150, 150]);
      const { store, scheduler, transport, settle } = ctx;
      transport.failures.push(new Error('offline'));
      const m = store.createMessage({ kind: 'note', body: 'dismissed quickly', sender: 'a' });
      await settle();
      store.markDone(m.id);
      transport.failures.push(new Error('offline'));
      const r = scheduler.create({ body: 'x', when: new Date(Date.now() + 3_600_000).toISOString(), sender: 'a' });
      await settle();
      scheduler.cancel(r.id);
      await new Promise((res) => setTimeout(res, 400));
      await settle();
      expect(transport.sends).toHaveLength(1);
      expect(transport.calls.filter((c) => c[0] === 'put')).toHaveLength(1);
      expect(transport.calls.filter((c) => c[0] === 'delete')).toHaveLength(1);
    });
  });

  describe('inbound', () => {
    it('a quote-reply to an ask answers it via WhatsApp', async () => {
      ctx = setup();
      const { asks, store, transport, relay, settle } = ctx;
      const ask = asks.create({ question: 'Merge the PR?', sender: 'agent' });
      await settle();
      const waId = store.getMessage(ask.id)!.waId!;
      const waiting = asks.wait(ask.id, 5000);
      await relay.handleFrame(inbound('wamid.in1', 'yes please', waId));
      expect(await waiting).toEqual({ id: ask.id, status: 'answered', answer: 'yes please', answeredVia: 'whatsapp' });
      // Redelivered: no second answer, no reply sent.
      await relay.handleFrame(inbound('wamid.in1', 'yes please', waId));
      await settle();
      expect(transport.sends).toHaveLength(1); // just the ask itself
    });

    it('a quote-reply to an already answered ask gets a short notice back', async () => {
      ctx = setup();
      const { asks, store, transport, relay, settle } = ctx;
      const ask = asks.create({ question: 'Merge the PR?', sender: 'agent' });
      await settle();
      asks.answer(ask.id, 'no', 'desk');
      await relay.handleFrame(inbound('wamid.in2', 'yes', store.getMessage(ask.id)!.waId));
      await settle();
      expect(transport.sends.at(-1)).toEqual({ text: '📎 That question was already answered (via desk): “no”.', kind: 'chat' });
      expect(store.getMessage(ask.id)?.answer).toBe('no');
    });

    it('plain text becomes a brain turn; the reply goes back as chat and is linked to its waId', async () => {
      let replyMessage: Message | undefined;
      ctx = setup((text) => {
        replyMessage = ctx.store.createMessage({ kind: 'chat', role: 'clippy', sender: 'clippy', body: `Indeed: ${text}`, state: 'done' });
        return { message: replyMessage };
      });
      const { store, transport, relay, asked, settle } = ctx;
      await relay.handleFrame(inbound('wamid.in3', 'what is due today?'));
      await settle();
      expect(asked).toEqual([['what is due today?', { channel: 'whatsapp' }]]);
      const userLine = store.findMessageByWaId('wamid.in3');
      expect(userLine).toMatchObject({ kind: 'chat', role: 'user', body: 'what is due today?', state: 'done' });
      expect(transport.sends).toEqual([{ text: 'Indeed: what is due today?', kind: 'chat' }]);
      expect(store.getMessage(replyMessage!.id)?.waId).toBe('wamid.1');
      // Redelivery of the same frame does nothing.
      await relay.handleFrame(inbound('wamid.in3', 'what is due today?'));
      await settle();
      expect(asked).toHaveLength(1);
      expect(JSON.parse(store.getKv(SEEN_KV_KEY)!)).toEqual(['wamid.in3']);
    });

    it('a quote-reply to a non-ask is chat with the quoted text as context; brain errors are sent back', async () => {
      ctx = setup(() => ({ error: "Claude Code isn't logged in." }));
      const { store, transport, relay, asked, settle } = ctx;
      store.createMessage({ kind: 'note', body: 'Build broke', sender: 'ci' });
      await settle();
      await relay.handleFrame(inbound('wamid.in4', 'why?', 'wamid.1'));
      await settle();
      expect(asked[0]![0]).toBe('(Replying to your earlier message: “Build broke”)\nwhy?');
      expect(transport.sends.at(-1)).toEqual({ text: "📎 Claude Code isn't logged in.", kind: 'chat' });
    });

    it('reminder-fired is reconciled without sending anything', async () => {
      ctx = setup();
      const { scheduler, store, transport, relay, settle } = ctx;
      const r = scheduler.create({ body: 'stretch', when: new Date(Date.now() + 3_600_000).toISOString(), sender: 'agent' });
      await relay.handleFrame({ type: 'reminder-fired', id: `${r.id}:${r.dueAt}`, reminderId: r.id, firedAt: r.dueAt, waId: 'wamid.rem' });
      await settle();
      expect(store.findMessageByWaId('wamid.rem')).toMatchObject({ kind: 'reminder', body: 'stretch' });
      expect(store.getReminder(r.id)?.active).toBe(false);
      expect(transport.sends).toEqual([]);
    });
  });
});

describe('RelayManager', () => {
  it('is off without a Worker URL and secret, and restarts only when they change', () => {
    const bus = new Bus();
    const store = new Store({ path: ':memory:', bus });
    alwaysMirror(bus, store);
    const transports: FakeTransport[] = [];
    const manager = new RelayManager({
      store,
      bus,
      scheduler: new Scheduler({ store, bus }),
      asks: new Asks({ store, bus }),
      brain: { ask: async () => ({}) },
      makeTransport: () => {
        const t = new FakeTransport();
        transports.push(t);
        return t;
      },
    });
    expect(relayConfig(DEFAULT_SETTINGS)).toBeUndefined();
    manager.apply(DEFAULT_SETTINGS);
    manager.apply({ ...DEFAULT_SETTINGS, workerUrl: 'https://w.example' }); // no secret yet
    expect(transports).toHaveLength(0);
    expect(manager.active).toBe(false);
    const on = { ...DEFAULT_SETTINGS, workerUrl: 'https://w.example', workerSecret: 's' };
    manager.apply(on);
    manager.apply({ ...on, soundEnabled: false }); // unrelated change: no restart
    expect(transports).toHaveLength(1);
    expect(manager.active).toBe(true);
    manager.reconnect();
    expect(transports[0]!.reconnects).toBe(1);
    manager.apply({ ...on, workerSecret: 's2' });
    expect(transports.map((t) => [t.started, t.stopped])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    manager.apply(DEFAULT_SETTINGS);
    expect(transports[1]!.stopped).toBe(1);
    expect(manager.active).toBe(false);
    manager.reconnect(); // off: nothing to do
    store.close();
  });
});

describe('RelayManager: reminder gap-fill', () => {
  const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const W1 = { ...DEFAULT_SETTINGS, workerUrl: 'https://relay-one.example.workers.dev', workerSecret: 's' };
  const W2 = { ...DEFAULT_SETTINGS, workerUrl: 'https://relay-two.example.workers.dev', workerSecret: 's' };
  const syncedKey = (url: string) => SYNCED_KV_PREFIX + normalizeWorkerUrl(url);

  /** `customise(transport, secret)` adjusts each new transport (e.g. a wrong secret gets 401s). */
  function managerSetup(customise: (t: FakeTransport, secret: string) => void = () => {}) {
    const bus = new Bus();
    const store = new Store({ path: ':memory:', bus });
    alwaysMirror(bus, store);
    const scheduler = new Scheduler({ store, bus });
    const transports: FakeTransport[] = [];
    const make = () =>
      new RelayManager({
        store,
        bus,
        scheduler,
        asks: new Asks({ store, bus }),
        brain: { ask: async () => ({}) },
        log: () => {},
        makeTransport: (config) => {
          const t = new FakeTransport();
          customise(t, config.workerSecret);
          transports.push(t);
          return t;
        },
      });
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    };
    /** PUT/DELETE calls on every transport so far, flattened as `put <id>` / `delete <id>`. */
    const reminderCalls = () =>
      transports.flatMap((t) => t.calls.filter((c) => c[0] !== 'send').map((c) => `${c[0]} ${c[1] as string}`));
    const synced = (url: string) => JSON.parse(store.getKv(syncedKey(url)) ?? '[]') as string[];
    return { store, scheduler, transports, make, settle, reminderCalls, synced };
  }

  it('PUTs the future reminders made while WhatsApp was off, once, with tz; restarts and reconnects add nothing', async () => {
    const { store, scheduler, transports, make, settle, reminderCalls, synced } = managerSetup();
    const soon = Date.now() + 3_600_000;
    const daily = scheduler.create({ body: 'standup', when: new Date(soon).toISOString(), rrule: 'FREQ=DAILY', sender: 'a' });
    const once = scheduler.create({ body: 'call mum', when: new Date(soon + 1000).toISOString(), sender: 'a' });
    const cancelled = scheduler.create({ body: 'never mind', when: new Date(soon).toISOString(), sender: 'a' });
    scheduler.cancel(cancelled.id);
    // Active but already overdue (the PC scheduler fires it): not sent to the Worker.
    const overdue = scheduler.create({ body: 'late', when: new Date(soon).toISOString(), sender: 'a' });
    store.updateReminder(overdue.id, { dueAt: Date.now() - 60_000 });

    let manager = make();
    manager.apply(DEFAULT_SETTINGS); // off: nothing
    expect(transports).toHaveLength(0);
    manager.apply(W1); // set up: the gap-fill
    await settle();
    expect(transports[0]!.calls).toEqual([
      ['put', daily.id, { body: 'standup', dueAt: daily.dueAt, rrule: 'FREQ=DAILY', startAt: soon, tz: TZ }],
      ['put', once.id, { body: 'call mum', dueAt: once.dueAt, tz: TZ }],
    ]);
    expect(synced(W1.workerUrl)).toEqual([daily.id, once.id]);

    // A reconnect, a new secret, an app restart (new manager), another spelling: nothing more.
    manager.reconnect();
    manager.apply({ ...W1, workerSecret: 's2' });
    manager.stop();
    manager = make();
    manager.apply(W1);
    manager.apply({ ...W1, workerUrl: `${W1.workerUrl}/` });
    await settle();
    expect(transports).toHaveLength(4);
    expect(reminderCalls()).toEqual([`put ${daily.id}`, `put ${once.id}`]);
    manager.stop();
    store.close();
  });

  it('a wrong secret syncs nothing; fixing the secret syncs everything', async () => {
    const { store, scheduler, make, settle, reminderCalls, synced } = managerSetup((t, secret) => {
      if (secret !== 'wrong') return;
      t.putReminder = async (id, body) => {
        t.calls.push(['put', id, body]);
        throw new RelayHttpError(401, 'unauthorized');
      };
    });
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const a = scheduler.create({ body: 'a', when, sender: 'x' });
    const b = scheduler.create({ body: 'b', when, sender: 'x' });
    const manager = make();
    manager.apply({ ...W1, workerSecret: 'wrong' }); // say VERIFY_TOKEN pasted instead of PC_SECRET
    await settle();
    expect(reminderCalls()).toEqual([`put ${a.id}`, `put ${b.id}`]); // both 401: permanent, given up
    expect(synced(W1.workerUrl)).toEqual([]);

    manager.apply({ ...W1, workerSecret: 'right' }); // corrected in Settings, same URL
    await settle();
    expect(reminderCalls().slice(2)).toEqual([`put ${a.id}`, `put ${b.id}`]);
    expect(synced(W1.workerUrl)).toEqual([a.id, b.id]);
    manager.stop();
    store.close();
  });

  it('a quit in the middle of the gap-fill is finished on the next start', async () => {
    let hang = true;
    const { store, scheduler, make, settle, reminderCalls, synced } = managerSetup((t) => {
      const put = t.putReminder.bind(t);
      t.putReminder = async (id, body) => {
        await put(id, body);
        if (hang && t.calls.length === 2) await new Promise(() => {}); // the 2nd PUT never answers
      };
    });
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const ids = ['a', 'b', 'c'].map((body) => scheduler.create({ body, when, sender: 'x' }).id);
    let manager = make();
    manager.apply(W1);
    await settle();
    expect(reminderCalls()).toEqual([`put ${ids[0]}`, `put ${ids[1]}`]);
    expect(synced(W1.workerUrl)).toEqual([ids[0]]); // only what got a 2xx
    manager.stop(); // the app quits

    hang = false;
    manager = make();
    manager.apply(W1); // next start
    await settle();
    expect(reminderCalls().slice(2)).toEqual([`put ${ids[1]}`, `put ${ids[2]}`]);
    expect(synced(W1.workerUrl)).toEqual(ids);
    manager.stop();
    store.close();
  });

  it('fills the gaps of a Worker it comes back to, and a new Worker gets everything active', async () => {
    let unreachable = true; // the first W1 transport can't reach the Worker for the withdrawal
    const { store, scheduler, make, settle, reminderCalls, synced } = managerSetup((t) => {
      if (!unreachable) return;
      unreachable = false;
      t.deleteReminder = async (id) => {
        t.calls.push(['delete', id]);
        throw new TypeError('fetch failed');
      };
    });
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const manager = make();
    manager.apply(W1);
    const a = scheduler.create({ body: 'a', when, sender: 'x' }); // synced live to W1
    await settle();
    expect(reminderCalls()).toEqual([`put ${a.id}`]);

    manager.apply(DEFAULT_SETTINGS); // WhatsApp switched off; withdrawing `a` fails
    await manager.withdrawn();
    expect(synced(W1.workerUrl)).toEqual([a.id]); // kept for the next gap-fill
    const b = scheduler.create({ body: 'b', when, sender: 'x' }); // made while off
    scheduler.cancel(a.id); // cancelled while off: W1 never heard

    manager.apply(W1); // back on, same Worker
    await settle();
    expect(reminderCalls().slice(2)).toEqual([`put ${b.id}`, `delete ${a.id}`]);
    expect(synced(W1.workerUrl)).toEqual([b.id]);

    manager.apply(W2); // moved to another Worker: W1 gives `b` up, W2 gets everything active
    await settle();
    await manager.withdrawn();
    expect(reminderCalls().slice(4)).toEqual([`delete ${b.id}`, `put ${b.id}`]);
    expect(synced(W1.workerUrl)).toEqual([]);
    expect(synced(W2.workerUrl)).toEqual([b.id]);
    manager.stop();
    store.close();
  });

  it('stops tracking a one-off the Worker fired, and a cancelled reminder', async () => {
    const { store, scheduler, transports, make, settle, synced } = managerSetup();
    const when = new Date(Date.now() + 3_600_000).toISOString();
    const manager = make();
    manager.apply(W1);
    const once = scheduler.create({ body: 'once', when, sender: 'x' });
    const daily = scheduler.create({ body: 'daily', when, rrule: 'FREQ=DAILY', sender: 'x' });
    const gone = scheduler.create({ body: 'gone', when, sender: 'x' });
    await settle();
    expect(synced(W1.workerUrl)).toEqual([once.id, daily.id, gone.id]);
    const onFrame = transports[0]!.onFrame!;
    const now = Date.now();
    await onFrame({ type: 'reminder-fired', id: `${once.id}:${now}`, reminderId: once.id, firedAt: now });
    await onFrame({ type: 'reminder-fired', id: `${daily.id}:${now}`, reminderId: daily.id, firedAt: now, nextDueAt: now + 86_400_000 });
    scheduler.cancel(gone.id);
    await settle();
    expect(synced(W1.workerUrl)).toEqual([daily.id]);
    manager.stop();
    store.close();
  });
});

describe('RelayManager: withdrawing reminders when WhatsApp is disconnected or moved', () => {
  const W1 = { ...DEFAULT_SETTINGS, workerUrl: 'https://relay-one.example.workers.dev', workerSecret: 's' };
  const W2 = { ...DEFAULT_SETTINGS, workerUrl: 'https://relay-two.example.workers.dev', workerSecret: 's' };
  const syncedKey = (url: string) => SYNCED_KV_PREFIX + normalizeWorkerUrl(url);

  function managerSetup(options: { customise?: (t: FakeTransport, index: number) => void; withdrawTimeoutMs?: number } = {}) {
    const bus = new Bus();
    const store = new Store({ path: ':memory:', bus });
    alwaysMirror(bus, store);
    const scheduler = new Scheduler({ store, bus });
    const transports: FakeTransport[] = [];
    const logs: string[] = [];
    const manager = new RelayManager({
      store,
      bus,
      scheduler,
      asks: new Asks({ store, bus }),
      brain: { ask: async () => ({}) },
      log: (m) => logs.push(m),
      ...(options.withdrawTimeoutMs !== undefined && { withdrawTimeoutMs: options.withdrawTimeoutMs }),
      makeTransport: () => {
        const t = new FakeTransport();
        options.customise?.(t, transports.length);
        transports.push(t);
        return t;
      },
    });
    const settle = async () => {
      for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 5));
    };
    /** PUT/DELETE calls on transport `i`, as `put <id>` / `delete <id>`. */
    const calls = (i: number) => (transports[i]?.calls ?? []).filter((c) => c[0] !== 'send').map((c) => `${c[0]} ${c[1] as string}`);
    const synced = (url: string) => JSON.parse(store.getKv(syncedKey(url)) ?? '[]') as string[];
    const when = new Date(Date.now() + 3_600_000).toISOString();
    return { store, scheduler, transports, manager, settle, calls, synced, logs, when };
  }

  /** Make `t.deleteReminder` hang until its signal aborts (or `release()` lets it succeed). */
  function hangDeletes(t: FakeTransport) {
    const signals: AbortSignal[] = [];
    const waiting: (() => void)[] = [];
    t.deleteReminder = (id, signal) => {
      t.calls.push(['delete', id]);
      if (signal) signals.push(signal);
      return new Promise<void>((resolve, reject) => {
        waiting.push(resolve);
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    };
    return { signals, release: () => waiting.splice(0).forEach((r) => r()) };
  }

  it('Disconnect DELETEs every reminder the Worker holds, then forgets them', async () => {
    const { store, scheduler, transports, manager, settle, calls, synced, when } = managerSetup();
    manager.apply(W1);
    const daily = scheduler.create({ body: 'standup', when, rrule: 'FREQ=DAILY', sender: 'x' });
    const once = scheduler.create({ body: 'call mum', when, sender: 'x' });
    await settle();
    expect(synced(W1.workerUrl)).toEqual([daily.id, once.id]);

    manager.apply({ ...W1, workerUrl: undefined, workerSecret: undefined }); // Settings → Disconnect
    expect(manager.active).toBe(false);
    await manager.withdrawn();
    expect(calls(0)).toEqual([`put ${daily.id}`, `put ${once.id}`, `delete ${daily.id}`, `delete ${once.id}`]);
    expect(synced(W1.workerUrl)).toEqual([]);
    expect(transports).toHaveLength(1); // nothing new started
    expect(transports[0]!.stopped).toBe(1);

    // Reminders made or cancelled while disconnected never reach the Worker.
    const offline = scheduler.create({ body: 'offline', when, sender: 'x' });
    scheduler.cancel(once.id);
    await settle();
    expect(calls(0)).toHaveLength(4);

    // Reconnecting to the same Worker puts back what is active.
    manager.apply(W1);
    await settle();
    expect(calls(1)).toEqual([`put ${daily.id}`, `put ${offline.id}`]);
    manager.stop();
    store.close();
  });

  it('clearing only the secret also withdraws (with the old secret)', async () => {
    const { store, scheduler, manager, settle, calls, synced, when } = managerSetup();
    manager.apply(W1);
    const r = scheduler.create({ body: 'r', when, sender: 'x' });
    await settle();
    manager.apply({ ...W1, workerSecret: undefined });
    await manager.withdrawn();
    expect(calls(0)).toEqual([`put ${r.id}`, `delete ${r.id}`]);
    expect(synced(W1.workerUrl)).toEqual([]);
    manager.stop();
    store.close();
  });

  it('a new secret for the same Worker withdraws nothing', async () => {
    const { store, scheduler, manager, settle, calls, synced, when } = managerSetup();
    manager.apply(W1);
    const r = scheduler.create({ body: 'r', when, sender: 'x' });
    await settle();
    manager.apply({ ...W1, workerSecret: 's2' });
    manager.apply({ ...W1, workerUrl: `${W1.workerUrl}/`, workerSecret: 's2' }); // same Worker, other spelling
    await settle();
    await manager.withdrawn();
    expect([calls(0), calls(1), calls(2)]).toEqual([[`put ${r.id}`], [], []]);
    expect(synced(W1.workerUrl)).toEqual([r.id]);
    manager.stop();
    store.close();
  });

  it('a Worker that refuses or is unreachable keeps the ids; the next gap-fill there removes them', async () => {
    const { store, scheduler, manager, settle, calls, synced, logs, when } = managerSetup({
      customise: (t, i) => {
        if (i !== 0) return;
        let n = 0;
        t.deleteReminder = async (id) => {
          t.calls.push(['delete', id]);
          if (n++ === 0) throw new RelayHttpError(401, 'unauthorized');
          throw new TypeError('fetch failed');
        };
      },
    });
    manager.apply(W1);
    const a = scheduler.create({ body: 'a', when, sender: 'x' });
    const b = scheduler.create({ body: 'b', when, sender: 'x' });
    await settle();
    manager.apply(DEFAULT_SETTINGS);
    await manager.withdrawn();
    expect(calls(0)).toEqual([`put ${a.id}`, `put ${b.id}`, `delete ${a.id}`, `delete ${b.id}`]);
    expect(synced(W1.workerUrl)).toEqual([a.id, b.id]);
    expect(logs.some((l) => l.includes('2 reminder(s) are still on'))).toBe(true);

    scheduler.cancel(a.id); // cancelled while off
    manager.apply(W1); // reconnect to that Worker: the gap-fill deletes the cancelled one
    await settle();
    expect(calls(1)).toEqual([`delete ${a.id}`]); // `b` is still active and still on W1
    expect(synced(W1.workerUrl)).toEqual([b.id]);
    manager.stop();
    store.close();
  });

  it('gives up after the time box; a DELETE answering late changes nothing', async () => {
    let hung!: ReturnType<typeof hangDeletes>;
    const { store, scheduler, manager, settle, synced, when } = managerSetup({
      withdrawTimeoutMs: 60,
      customise: (t, i) => {
        if (i === 0) hung = hangDeletes(t);
      },
    });
    manager.apply(W1);
    const r = scheduler.create({ body: 'r', when, sender: 'x' });
    await settle();
    const t0 = Date.now();
    manager.apply(DEFAULT_SETTINGS);
    await manager.withdrawn();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(hung.signals.map((s) => s.aborted)).toEqual([true]); // the request itself was cancelled
    hung.release();
    await settle();
    expect(synced(W1.workerUrl)).toEqual([r.id]);
    manager.stop();
    store.close();
  });

  it('quitting abandons a withdrawal at once', async () => {
    let hung!: ReturnType<typeof hangDeletes>;
    const { store, scheduler, manager, settle, synced, when } = managerSetup({
      customise: (t, i) => {
        if (i === 0) hung = hangDeletes(t);
      },
    });
    manager.apply(W1);
    const r = scheduler.create({ body: 'r', when, sender: 'x' });
    await settle();
    manager.apply(DEFAULT_SETTINGS); // default 10 s time box
    await settle();
    const t0 = Date.now();
    manager.stop(); // the app quits
    await manager.withdrawn();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(hung.signals.map((s) => s.aborted)).toEqual([true]);
    expect(synced(W1.workerUrl)).toEqual([r.id]);
    store.close();
  });

  it('a PUT in flight at Disconnect is withdrawn once it lands, without holding up the others', async () => {
    let releasePut: (() => void) | undefined;
    let hangPuts = false;
    const { store, scheduler, manager, settle, calls, synced, when } = managerSetup({
      customise: (t, i) => {
        if (i !== 0) return;
        const put = t.putReminder.bind(t);
        t.putReminder = async (id, body) => {
          await put(id, body);
          if (hangPuts) await new Promise<void>((resolve) => (releasePut = resolve));
        };
      },
    });
    manager.apply(W1);
    const a = scheduler.create({ body: 'a', when, sender: 'x' });
    await settle();
    hangPuts = true;
    const r = scheduler.create({ body: 'r', when, sender: 'x' });
    await settle(); // r's PUT is on its way
    manager.apply(DEFAULT_SETTINGS);
    await settle();
    expect(calls(0)).toEqual([`put ${a.id}`, `put ${r.id}`, `delete ${a.id}`]); // `a` goes at once
    expect(synced(W1.workerUrl)).toEqual([]);
    releasePut!(); // the Worker acknowledges r
    await manager.withdrawn();
    expect(calls(0)).toEqual([`put ${a.id}`, `put ${r.id}`, `delete ${a.id}`, `delete ${r.id}`]);
    expect(synced(W1.workerUrl)).toEqual([]);
    manager.stop();
    store.close();
  });

  it('coming back to a Worker mid-withdrawal waits for it before the gap-fill', async () => {
    let hung!: ReturnType<typeof hangDeletes>;
    const { store, scheduler, manager, settle, calls, synced, when } = managerSetup({
      customise: (t, i) => {
        if (i === 0) hung = hangDeletes(t);
      },
    });
    manager.apply(W1);
    const r = scheduler.create({ body: 'r', when, sender: 'x' });
    await settle();
    manager.apply(DEFAULT_SETTINGS);
    manager.apply(W1); // changed their mind
    await settle();
    expect(calls(1)).toEqual([]); // no gap-fill yet
    hung.release(); // the DELETE lands
    await manager.withdrawn();
    await settle();
    expect(calls(1)).toEqual([`put ${r.id}`]); // so it is put back
    expect(synced(W1.workerUrl)).toEqual([r.id]);
    manager.stop();
    store.close();
  });

  it('moving to another Worker withdraws from the old one while the new one syncs', async () => {
    const { store, scheduler, manager, settle, calls, synced, when } = managerSetup();
    manager.apply(W1);
    const r = scheduler.create({ body: 'r', when, rrule: 'FREQ=WEEKLY', sender: 'x' });
    await settle();
    manager.apply(W2);
    await manager.withdrawn();
    await settle();
    expect(calls(0)).toEqual([`put ${r.id}`, `delete ${r.id}`]);
    expect(calls(1)).toEqual([`put ${r.id}`]);
    expect(synced(W1.workerUrl)).toEqual([]);
    expect(synced(W2.workerUrl)).toEqual([r.id]);
    manager.stop();
    store.close();
  });
});

describe('Relay over a real socket (fake Worker)', () => {
  let worker: FakeWorker;
  let dir: string;
  beforeEach(async () => {
    worker = await new FakeWorker().listen();
    dir = mkdtempSync(join(tmpdir(), 'clippy-relay-'));
  });
  afterEach(async () => {
    await worker.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('mirrors an ask, then a WhatsApp quote-reply answers it and is acked', async () => {
    const bus = new Bus();
    const store = new Store({ path: join(dir, 'clippy.db'), bus });
    alwaysMirror(bus, store);
    const scheduler = new Scheduler({ store, bus });
    const asks = new Asks({ store, bus });
    const manager = new RelayManager({ store, bus, scheduler, asks, brain: { ask: async () => ({}) }, log: () => {} });
    manager.apply({ ...DEFAULT_SETTINGS, workerUrl: worker.url, workerSecret: worker.secret });
    try {
      await waitFor(() => worker.openSockets === 1, 3000, 'socket');
      const ask = asks.create({ question: 'Proceed?', sender: 'agent' });
      await waitFor(() => store.getMessage(ask.id)?.waId !== undefined, 3000, 'ask mirrored');
      const waId = store.getMessage(ask.id)!.waId!;
      worker.push({ type: 'inbound', id: 'wamid.reply', text: 'go ahead', contextWaId: waId, ts: 1 });
      await waitFor(() => worker.acks.includes('wamid.reply'), 3000, 'ack');
      expect(asks.result(ask.id)).toEqual({ id: ask.id, status: 'answered', answer: 'go ahead', answeredVia: 'whatsapp' });
      expect(worker.requests.map((r) => `${r.method} ${r.path} ${r.auth}`)).toEqual(['POST /send Bearer test-secret']);
    } finally {
      manager.stop();
      store.close();
    }
  });
});
