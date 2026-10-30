import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, RelaySendRequest } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCore, type Core } from '../src/main/core/core';
import type { RelayTransport } from '../src/main/relay/relayClient';
import { startServices, type Services } from '../src/main/startup';
import { Store } from '../src/main/core/store';
import { MISSED_NOTE } from '../src/main/telegram/format';
import { fakeRunner, type ScriptedRun } from './brain/fixtures';
import { FakeClock } from './core/fakeClock';
import { actions, fakeExecutor } from './power/fakeExecutor';
import { FakeTelegram, fakeSecrets, guardFetch, waitFor } from './telegram/fakeTelegram';


/** A Saturday noon clock: the weekday-only morning brief stays out of tests that count messages. */
const quietBrief = () => ({ clock: new FakeClock(new Date(2026, 9, 31, 12).getTime()) });

describe('startServices', () => {
  let dir: string;
  let services: Services | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-startup-'));
  });
  afterEach(async () => {
    services?.phoneGate.stop();
    services?.watcher.stop();
    services?.brief.stop();
    services?.relay.stop();
    await services?.telegram.stop();
    services?.brain.dispose();
    await services?.core.stop();
    services = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  it('power actions follow the allowPowerActions setting, and leftovers are expired on the next start', async () => {
    const fake = fakeExecutor();
    const start = () =>
      startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brief: quietBrief(), brain: { emit: () => {} }, powerExecutor: fake });
    services = await start();
    await expect(services.core.power.requestRestartPc()).rejects.toThrow(/turned off/);
    await services.settings.update({ allowPowerActions: true });
    const { id } = await services.core.power.requestRestartApp('chrome');
    expect(services.core.asks.result(id).status).toBe('pending');

    // Clippy quits and starts again: the old question is closed, and nothing runs.
    services.phoneGate.stop();
    services.watcher.stop();
    services.brief.stop();
    services.relay.stop();
    await services.telegram.stop();
    services.brain.dispose();
    await services.core.stop();
    services = await start();
    expect(services.core.asks.result(id)).toMatchObject({ status: 'answered', answer: 'Expired' });
    await services.core.power.settled();
    expect(actions(fake)).toEqual([]);
  });

  it('phone approvals need both phoneApprovals and the hook, follow the away time, and leftovers expire on the next start', async () => {
    let idle = 0;
    const start = () =>
      startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brief: quietBrief(), brain: { emit: () => {} }, idleSeconds: () => idle });
    services = await start();
    const request = { tool: 'Bash', input: { command: 'npm test' }, sender: 'claude-code', project: 'payments' };
    expect(services.core.approvals.request(request)).toEqual({ status: 'off' }); // off by default
    await services.settings.update({ phoneApprovals: true, hookEnabled: false });
    expect(services.core.approvals.request(request)).toEqual({ status: 'off' });
    await services.settings.update({ hookEnabled: true, awayThresholdS: 180 });
    expect(services.core.approvals.request(request)).toEqual({ status: 'at-desk' });
    idle = 180;
    const result = services.core.approvals.request(request);
    expect(result).toMatchObject({ status: 'waiting' });
    const { id } = result as { id: string };

    // Clippy quits and starts again: the old question is closed ("Expired"), which the hook takes as no decision.
    services.phoneGate.stop();
    services.watcher.stop();
    services.brief.stop();
    services.relay.stop();
    await services.telegram.stop();
    services.brain.dispose();
    await services.core.stop();
    services = await start();
    expect(services.core.asks.result(id)).toMatchObject({ status: 'answered', answer: 'Expired', answeredVia: 'clippy' });
    expect(services.core.approvals.isOpen(id)).toBe(false);
  });

  it('has the relay listening before the first API request can be handled', async () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ workerUrl: 'https://relay.example.workers.dev', workerSecret: 's' }));
    const sends: RelaySendRequest[] = [];
    const transport: RelayTransport = {
      start() {},
      stop() {},
      reconnect() {},
      async send(request) {
        sends.push(request);
        return { waId: 'wamid.first', mode: 'template' };
      },
      async putReminder() {},
      async deleteReminder() {},
    };
    let firstNoteId: string | undefined;
    services = await startServices({
      dataDir: dir,
      settingsFile: join(dir, 'settings.json'),
      brief: quietBrief(),
      brain: { emit: () => {} },
      makeTransport: () => transport,
      relayLog: () => {},
      // An agent's request lands on the very next turn of the event loop after the API is live
      // (the MCP server polls /health and posts at once).
      startCore: async (options): Promise<Core> => {
        const core = await startCore(options);
        setImmediate(() => {
          firstNoteId = core.store.createMessage({ kind: 'note', body: 'first!', sender: 'agent' }).id;
        });
        return core;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(firstNoteId).toBeDefined();
    expect(sends.map((s) => s.text)).toEqual(['📝 first!\n\n— agent']);
    expect(services.core.store.getMessage(firstNoteId!)?.waId).toBe('wamid.first');
    expect(services.relay.active).toBe(true);
  });

  it('answers an ask from a standing order with the brain runner and hooks-off settings, and runs nothing without orders', async () => {
    const script: ScriptedRun[] = [];
    const fake = fakeRunner(script);
    services = await startServices({
      dataDir: dir,
      settingsFile: join(dir, 'settings.json'),
      brief: quietBrief(),
      brain: { emit: () => {}, runner: fake.runner, cwd: 'C:/home', env: { PATH: 'x' } },
    });
    const { core } = services;
    const post = async (question: string) => {
      const res = await fetch(`http://127.0.0.1:${core.port}/asks`, {
        method: 'POST',
        headers: { authorization: `Bearer ${core.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ question, sender: 'claude-code' }),
      });
      return (await res.json()) as Message;
    };

    // No orders: a normal ask, and the CLI is never started.
    expect(await post('Which branch?')).toMatchObject({ state: 'unread' });
    expect(fake.calls).toEqual([]);

    // The order is read from the running core at the time of the ask.
    const order = core.store.insertOrder('When an agent asks which branch to use, answer: staging');
    const reply = JSON.stringify({ type: 'result', is_error: false, result: JSON.stringify({ order: order.id, answer: 'staging' }) });
    script.push({ stdout: reply });
    const answered = await post('Which branch should I deploy?');
    expect(answered).toMatchObject({ state: 'done', answer: 'staging', answeredVia: 'clippy', orderId: order.id });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.stdin).toContain('Which branch should I deploy?');
    expect(call.stdin).toContain(order.id);
    expect(call.cwd).toBe('C:/home');
    expect(call.args[call.args.indexOf('--settings') + 1]).toBe(join(dir, 'brain', 'brain-settings.json'));
  });

  it('has Telegram listening before the first API request, and sends what the startup catch-up fired', async () => {
    const guard = guardFetch();
    const fake = await FakeTelegram.start();
    try {
      // A reminder that came due while the app was off, and a plaintext token written headlessly.
      const db = new Store({ path: join(dir, 'clippy.db') });
      const now = Date.now();
      db.insertReminder({ id: db.newId(), body: 'Missed me?', sender: 'agent', dueAt: now - 3_600_000, active: true, createdAt: now - 7_200_000, startAt: now - 3_600_000 });
      db.close();
      writeFileSync(join(dir, 'settings.json'), JSON.stringify({ telegramBotToken: fake.token, telegramChatId: 4242 }));

      services = await startServices({
        dataDir: dir,
        settingsFile: join(dir, 'settings.json'),
        brief: quietBrief(),
        brain: { emit: () => {} },
        secrets: fakeSecrets,
        telegram: { baseUrl: fake.baseUrl, log: () => {} },
        startCore: async (options): Promise<Core> => {
          const core = await startCore(options);
          setImmediate(() => core.store.createMessage({ kind: 'note', body: 'first!', sender: 'agent' }));
          return core;
        },
      });
      expect(services.telegram.active).toBe(true);
      await waitFor(() => fake.sentTexts.length === 2, 3000, 'both messages');
      expect(fake.sentTexts).toEqual([`⏰ Missed me?\n\n<i>— agent</i>\n<i>${MISSED_NOTE}</i>`, '📝 first!\n\n<i>— agent</i>']);
      const onDisk = readFileSync(join(dir, 'settings.json'), 'utf8');
      expect(onDisk).not.toContain(fake.token);
      expect(JSON.parse(onDisk)).toMatchObject({ telegramChatId: 4242, telegramBotTokenEnc: fakeSecrets.encrypt(fake.token) });
      expect(guard.urls.every((u) => u.startsWith(fake.baseUrl))).toBe(true);
    } finally {
      await services?.telegram.stop();
      await fake.close();
      guard.restore();
    }
  });

  it('files away-only notes quietly while the user is at the PC, and treats them as normal once away', async () => {
    const guard = guardFetch();
    const fake = await FakeTelegram.start();
    const relaySends: RelaySendRequest[] = [];
    const transport: RelayTransport = {
      start() {},
      stop() {},
      reconnect() {},
      async send(request) {
        relaySends.push(request);
        return { waId: `wamid.${relaySends.length}`, mode: 'freeform' };
      },
      async putReminder() {},
      async deleteReminder() {},
    };
    let idle = 5; // seconds since the last input: at the PC
    try {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ telegramBotToken: fake.token, telegramChatId: 4242, workerUrl: 'https://relay.example.workers.dev', workerSecret: 's', awayThresholdS: 180 }),
      );
      services = await startServices({
        dataDir: dir,
        settingsFile: join(dir, 'settings.json'),
        brief: quietBrief(),
        brain: { emit: () => {} },
        secrets: fakeSecrets,
        telegram: { baseUrl: fake.baseUrl, log: () => {} },
        makeTransport: () => transport,
        relayLog: () => {},
        idleSeconds: () => idle,
        phoneGate: { tickMs: 20 },
      });
      const { port, token } = services.core;
      const post = async (input: object) => {
        const res = await fetch(`http://127.0.0.1:${port}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ sender: 'claude-code', project: 'shop', ...input }),
        });
        return (await res.json()) as Message;
      };

      const quiet = await post({ body: '✅ shop agent finished', quietIfActive: true });
      expect(quiet).toMatchObject({ state: 'done', quietIfActive: true });
      expect(quiet.doneAt).toBeDefined(); // in History
      const normal = await post({ body: 'a normal note' }); // without the flag: as always
      expect(normal.state).toBe('unread');

      idle = 600; // away for 10 minutes
      const away = await post({ body: '✅ shop agent finished, again', quietIfActive: true });
      expect(away).toMatchObject({ state: 'unread', quietIfActive: true });

      // The away note goes at once; the normal note was held at the PC and follows on a tick
      // (which may even land before the away note's request does, hence the sort).
      await waitFor(() => fake.sentTexts.length === 2 && relaySends.length === 2, 3000, 'the mirrors');
      await new Promise((r) => setTimeout(r, 50));
      const expected = ['📝 ✅ shop agent finished, again', '📝 a normal note'].sort();
      expect(fake.sentTexts.map((t) => t.split('\n')[0]).sort()).toEqual(expected);
      expect(relaySends.map((s) => s.text.split('\n')[0]).sort()).toEqual(expected);
      expect(services.core.store.listMessages({ state: 'unread' }).map((m) => m.id).sort()).toEqual([normal.id, away.id].sort());

      // The threshold is read live from settings.
      await services.settings.update({ awayThresholdS: 3600 });
      expect((await post({ body: 'quiet again', quietIfActive: true })).state).toBe('done');
    } finally {
      await services?.telegram.stop();
      await fake.close();
      guard.restore();
    }
  });

  describe('the phone only hears while the user is away', () => {
    /** Starts the services with both channels on, then posts one agent note through the API. */
    async function postNote(idleSeconds: () => number, settings: object = {}) {
      const fake = await FakeTelegram.start();
      const relaySends: RelaySendRequest[] = [];
      const transport: RelayTransport = {
        start() {},
        stop() {},
        reconnect() {},
        async send(request) {
          relaySends.push(request);
          return { waId: `wamid.${relaySends.length}`, mode: 'freeform' };
        },
        async putReminder() {},
        async deleteReminder() {},
      };
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ telegramBotToken: fake.token, telegramChatId: 4242, workerUrl: 'https://relay.example.workers.dev', workerSecret: 's', ...settings }),
      );
      services = await startServices({
        dataDir: dir,
        settingsFile: join(dir, 'settings.json'),
        brief: quietBrief(),
        brain: { emit: () => {} },
        secrets: fakeSecrets,
        telegram: { baseUrl: fake.baseUrl, log: () => {} },
        makeTransport: () => transport,
        relayLog: () => {},
        idleSeconds,
        phoneGate: { tickMs: 20 },
      });
      await fetch(`http://127.0.0.1:${services.core.port}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${services.core.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sender: 'claude-code', body: 'a note' }),
      });
      await new Promise((r) => setTimeout(r, 150));
      return { fake, relaySends };
    }

    it('does not send an agent note to Telegram or WhatsApp while the user is at the PC', async () => {
      const guard = guardFetch();
      const { fake, relaySends } = await postNote(() => 0);
      try {
        expect(fake.sentTexts).toEqual([]);
        expect(relaySends).toEqual([]);
        expect(services!.phoneGate.heldIds).toHaveLength(1);
      } finally {
        await services?.telegram.stop();
        await fake.close();
        guard.restore();
      }
    });

    it('sends it at once when the user is away', async () => {
      const guard = guardFetch();
      const { fake, relaySends } = await postNote(() => 10_000);
      try {
        expect(fake.sentTexts).toEqual(['📝 a note\n\n<i>— claude-code</i>']);
        expect(relaySends.map((s) => s.text)).toEqual(['📝 a note\n\n— claude-code']);
      } finally {
        await services?.telegram.stop();
        await fake.close();
        guard.restore();
      }
    });

    it('sends it at once at the PC when the setting is "Always"', async () => {
      const guard = guardFetch();
      const { fake, relaySends } = await postNote(() => 0, { phoneWhen: 'always' });
      try {
        expect(fake.sentTexts).toHaveLength(1);
        expect(relaySends).toHaveLength(1);
      } finally {
        await services?.telegram.stop();
        await fake.close();
        guard.restore();
      }
    });
  });

  it('without an idle source, away-only notes interrupt like any other', async () => {
    services = await startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brief: quietBrief(), brain: { emit: () => {} } });
    const res = await fetch(`http://127.0.0.1:${services.core.port}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${services.core.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'done', sender: 'claude-code', quietIfActive: true }),
    });
    expect(((await res.json()) as Message).state).toBe('unread');
  });

  it('nudges when a watched agent finishes, through the API a hook posts to', async () => {
    services = await startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brief: quietBrief(), brain: { emit: () => {} } });
    const { core } = services;
    const post = (path: string, body: unknown) =>
      fetch(`http://127.0.0.1:${core.port}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${core.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    await post('/watches', { project: 'payments', nudge: 'Deploy to staging' });
    await post('/messages', { body: '✅ payments agent finished', sender: 'claude-code', project: 'payments', quietIfActive: true, event: 'agent-finished' });
    const nudge = core.store.listMessages({}).find((m) => m.sender === 'clippy');
    expect(nudge).toMatchObject({ title: '⏰ Nudge', body: 'Deploy to staging\n(payments agent finished)', state: 'unread' });
    expect(core.store.listActiveWatches()).toEqual([]);
  });

  it('POST /look saves the theme into the settings file and returns the look', async () => {
    services = await startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brief: quietBrief(), brain: { emit: () => {} } });
    const res = await fetch(`http://127.0.0.1:${services.core.port}/look`, {
      method: 'POST',
      headers: { authorization: `Bearer ${services.core.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ theme: 'night', followSystemDark: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: 'night', followSystemDark: true, darkTheme: 'night' });
    expect(services.settings.get()).toMatchObject({ theme: 'night', followSystemDark: true });
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))).toMatchObject({ theme: 'night', followSystemDark: true });
  });

  it('wires settings changes to the relay and writes the brain files first', async () => {
    let transports = 0;
    services = await startServices({
      dataDir: dir,
      settingsFile: join(dir, 'settings.json'),
      brief: quietBrief(),
      brain: { emit: () => {} },
      makeTransport: () => {
        transports++;
        return { start() {}, stop() {}, reconnect() {}, send: async () => ({ waId: 'w', mode: 'freeform' }), putReminder: async () => {}, deleteReminder: async () => {} };
      },
    });
    expect(services.relay.active).toBe(false); // no Worker configured: nothing on the network
    expect(services.telegram.active).toBe(false); // no Telegram token either
    await services.settings.update({ workerUrl: 'https://relay.example.workers.dev', workerSecret: 's' });
    expect(services.relay.active).toBe(true);
    expect(transports).toBe(1);
    expect(services.brain.buildArgs(undefined)).toContain(join(dir, 'brain', 'brain-settings.json'));
  });

  it('leaves the morning brief when it is due, rearms it when its settings change, and stops it with the app', async () => {
    const clock = new FakeClock(new Date(2026, 9, 30, 10, 30).getTime()); // a Friday, 90 minutes after 09:00
    services = await startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brief: { clock }, brain: { emit: () => {} } });
    const briefs = () => services!.core.store.listMessages({}).filter((m) => m.sender === 'clippy' && m.title === '☀️ Morning brief');
    expect(briefs()).toHaveLength(1);
    expect(clock.pending).toBe(1);
    await services.settings.update({ briefEnabled: false });
    expect(clock.pending).toBe(0);
    await services.settings.update({ briefEnabled: true, briefTime: '18:00' });
    expect(clock.nextAt).toBe(new Date(2026, 9, 30, 11, 30).getTime()); // armed in hour-long steps, not sent early
    services.brief.stop();
    expect(clock.pending).toBe(0);
  });
});
