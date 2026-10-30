import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RelaySendRequest } from '@clippy/shared';
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
