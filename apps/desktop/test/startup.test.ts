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
import { FakeTelegram, fakeSecrets, guardFetch, waitFor } from './telegram/fakeTelegram';


describe('startServices', () => {
  let dir: string;
  let services: Services | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-startup-'));
  });
  afterEach(async () => {
    services?.relay.stop();
    await services?.telegram.stop();
    services?.brain.dispose();
    await services?.core.stop();
    services = undefined;
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
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
    services = await startServices({ dataDir: dir, settingsFile: join(dir, 'settings.json'), brain: { emit: () => {} } });
    const res = await fetch(`http://127.0.0.1:${services.core.port}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${services.core.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'done', sender: 'claude-code', quietIfActive: true }),
    });
    expect(((await res.json()) as Message).state).toBe('unread');
  });

  it('wires settings changes to the relay and writes the brain files first', async () => {
    let transports = 0;
    services = await startServices({
      dataDir: dir,
      settingsFile: join(dir, 'settings.json'),
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
});
