import type { WorkerToPc } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backoffDelay, RelayClient, RelayHttpError, relayUrl } from '../../src/main/relay/relayClient';
import { FakeWorker, waitFor } from './fakeWorker';

const inbound = (id: string, text = 'hi'): WorkerToPc => ({ type: 'inbound', id, text, ts: 1 });

describe('relayUrl', () => {
  it('builds REST and WebSocket URLs from the Worker base URL', () => {
    expect(relayUrl('https://clippy.example.workers.dev', '/send')).toBe('https://clippy.example.workers.dev/send');
    expect(relayUrl('https://clippy.example.workers.dev/', '/ws', 'ws')).toBe('wss://clippy.example.workers.dev/ws');
    expect(relayUrl('http://127.0.0.1:8787/base/', '/ws', 'ws')).toBe('ws://127.0.0.1:8787/base/ws');
  });
});

describe('RelayClient', () => {
  let worker: FakeWorker;
  let client: RelayClient | undefined;
  let logs: string[];

  beforeEach(async () => {
    worker = await new FakeWorker().listen();
    logs = [];
  });
  afterEach(async () => {
    client?.stop();
    client = undefined;
    await worker.close();
  });

  function make(extra: Partial<ConstructorParameters<typeof RelayClient>[0]> = {}) {
    client = new RelayClient({
      workerUrl: worker.url,
      workerSecret: worker.secret,
      backoffMinMs: 20,
      backoffMaxMs: 80,
      log: (m) => logs.push(m),
      ...extra,
    });
    return client;
  }

  it('calls the REST routes with the bearer secret', async () => {
    const c = make();
    expect(await c.send({ text: 'hello', kind: 'note', urgent: true })).toEqual({ waId: 'wamid.1', mode: 'freeform' });
    await c.putReminder('R1', { body: 'stretch', dueAt: 5, rrule: 'FREQ=DAILY', tz: 'America/Vancouver' });
    await c.deleteReminder('R1');
    expect(worker.requests).toEqual([
      { method: 'POST', path: '/send', auth: 'Bearer test-secret', body: { text: 'hello', kind: 'note', urgent: true } },
      {
        method: 'PUT',
        path: '/reminders/R1',
        auth: 'Bearer test-secret',
        body: { body: 'stretch', dueAt: 5, rrule: 'FREQ=DAILY', tz: 'America/Vancouver' },
      },
      { method: 'DELETE', path: '/reminders/R1', auth: 'Bearer test-secret', body: undefined },
    ]);
  });

  it('turns Worker errors into RelayHttpError (4xx permanent, 502 not)', async () => {
    worker.sendFailures.push(502);
    const err = await make().send({ text: 'x', kind: 'note' }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayHttpError);
    expect(err).toMatchObject({ status: 502, permanent: false });
    expect(err.message).toContain('meta said no');
    const bad = new RelayClient({ workerUrl: worker.url, workerSecret: 'wrong' });
    expect(await bad.send({ text: 'x', kind: 'note' }).catch((e) => e)).toMatchObject({ status: 401, permanent: true });
  });

  it('connects with the bearer, handles frames in order and acks each only after its handler', async () => {
    worker.outbox.push(inbound('a'), inbound('b'));
    const handled: string[] = [];
    make().start(async (f) => {
      handled.push(`start ${f.id}`);
      await new Promise((r) => setTimeout(r, 20));
      handled.push(`end ${f.id}`);
    });
    await waitFor(() => worker.acks.length === 2, 3000, 'acks');
    expect(handled).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(worker.acks).toEqual(['a', 'b']);
    expect(client!.connected).toBe(true);
    worker.push(inbound('c'));
    await waitFor(() => worker.acks.includes('c'));
    expect(worker.outbox).toEqual([]);
  });

  it('leaves a frame unacked when its handler throws; it comes back after a reconnect', async () => {
    let fail = true;
    const handled: string[] = [];
    make().start(async (f) => {
      handled.push(f.id);
      if (fail) throw new Error('db busy');
    });
    await waitFor(() => worker.openSockets === 1);
    worker.push(inbound('x'));
    await waitFor(() => handled.length === 1);
    await new Promise((r) => setTimeout(r, 30));
    expect(worker.acks).toEqual([]);
    fail = false;
    worker.dropAll();
    await waitFor(() => worker.acks.includes('x'), 3000, 'redelivered ack');
    expect(handled).toEqual(['x', 'x']);
    expect(worker.connections).toBe(2);
  });

  it('ignores malformed and unknown frames', async () => {
    const handled: string[] = [];
    make().start(async (f) => void handled.push(f.id));
    await waitFor(() => worker.openSockets === 1);
    worker.pushRaw('not json');
    worker.pushRaw(JSON.stringify({ type: 'mystery', id: 'm' }));
    worker.push(inbound('ok'));
    await waitFor(() => worker.acks.includes('ok'));
    expect(handled).toEqual(['ok']);
    expect(logs.some((l) => l.includes('non-JSON'))).toBe(true);
    expect(logs.some((l) => l.includes('unknown frame'))).toBe(true);
  });

  it('reconnects with exponential backoff while the secret is refused, and stop() ends it', async () => {
    const c = new RelayClient({ workerUrl: worker.url, workerSecret: 'wrong', backoffMinMs: 20, backoffMaxMs: 80, log: () => {} });
    client = c;
    c.start(async () => {});
    await waitFor(() => worker.rejectedUpgrades >= 4, 3000, 'retries');
    c.stop();
    const after = worker.rejectedUpgrades;
    await new Promise((r) => setTimeout(r, 200));
    expect(worker.rejectedUpgrades).toBe(after);
  });

  it('backs off 1 s → 60 s by default', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 30].map((n) => backoffDelay(n))).toEqual([
      1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000,
    ]);
  });

  it('drops and replaces a socket that stops answering pings', async () => {
    await worker.close();
    worker = await new FakeWorker({ autoPong: false }).listen();
    make({ pingIntervalMs: 40 }).start(async () => {});
    await waitFor(() => worker.connections >= 2, 3000, 'reconnect after missed pong');
    expect(logs.some((l) => l.includes('stopped answering pings'))).toBe(true);
  });

  it('does not reset the backoff on open alone: accept-then-close backs off instead of looping', async () => {
    worker.closeOnAccept = true;
    make({ backoffMinMs: 20, backoffMaxMs: 10_000 }).start(async () => {});
    await new Promise((r) => setTimeout(r, 700));
    // 20+40+80+160+320 ms of backoff fits in 700 ms about 5 times; resetting on open would give ~25.
    expect(worker.connections).toBeGreaterThanOrEqual(3);
    expect(worker.connections).toBeLessThanOrEqual(7);
  });

  it('resets the backoff once a frame arrives', async () => {
    const handled: string[] = [];
    make({ backoffMinMs: 20, backoffMaxMs: 10_000 }).start(async (f) => void handled.push(f.id));
    await waitFor(() => worker.openSockets === 1);
    worker.push(inbound('hello'));
    await waitFor(() => handled.length === 1);
    worker.dropAll();
    const t0 = Date.now();
    await waitFor(() => worker.connections === 2, 3000, 'quick reconnect');
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('reconnect() replaces a live socket at once (after the PC wakes)', async () => {
    const c = make();
    c.start(async () => {});
    await waitFor(() => worker.openSockets === 1);
    c.reconnect();
    await waitFor(() => worker.connections === 2, 3000, 'second connection');
    await waitFor(() => worker.openSockets === 1, 3000, 'old socket closed');
  });

  it('a dropped connection is re-established and frames pushed meanwhile are delivered', async () => {
    const handled: string[] = [];
    make().start(async (f) => void handled.push(f.id));
    await waitFor(() => worker.openSockets === 1);
    worker.dropAll();
    worker.push(inbound('while-down')); // queued in the outbox, no socket
    await waitFor(() => handled.includes('while-down'), 3000, 'redelivery after reconnect');
    expect(worker.connections).toBe(2);
  });
});
