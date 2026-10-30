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
import { formatForWhatsApp, Relay, SEEN_KV_KEY } from '../../src/main/relay/relay';
import { RelayHttpError, type FrameHandler, type RelayTransport } from '../../src/main/relay/relayClient';
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
  async deleteReminder(id: string) {
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
        ['put', daily.id, { body: 'standup', dueAt: daily.dueAt, rrule: 'FREQ=DAILY', tz: 'America/Vancouver' }],
        ['put', once.id, { body: 'call mum', dueAt: once.dueAt, tz: 'America/Vancouver' }],
        ['delete', once.id],
      ]);
      // A restart of the relay (reconnect) sends nothing.
      relay.stop();
      relay.start();
      await settle();
      expect(transport.calls).toHaveLength(3);
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
