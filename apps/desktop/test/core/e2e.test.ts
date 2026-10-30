/**
 * End-to-end: the real `ClippyClient` from @clippy/shared against a real core
 * (SQLite file, HTTP server, scheduler) in a temp CLIPPY_HOME.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClippyApiError, ClippyClient, ClippyNotRunningError, type Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreEventMap } from '../../src/main/core/bus';
import { startCore, type Core } from '../../src/main/core/core';

describe('ClippyClient ↔ core (end to end)', () => {
  let dir: string;
  let core: Core;
  let client: ClippyClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-e2e-'));
    vi.stubEnv('CLIPPY_HOME', dir);
    core = await startCore({ version: '0.1.0' });
    client = await ClippyClient.fromAppData();
  });
  afterEach(async () => {
    await core.stop();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  it('connects from the app data files and reports health', async () => {
    expect(client.baseUrl).toBe(`http://127.0.0.1:${core.port}`);
    expect(await client.health()).toEqual({ ok: true, version: '0.1.0' });
  });

  it('posts, lists, searches, snoozes and dismisses messages', async () => {
    const newEvents: Message[] = [];
    core.bus.on('message:new', (m) => newEvents.push(m));

    const deploy = await client.postMessage({ body: 'Deploy finished for build 42', sender: 'claude-code', project: 'shop' });
    const failing = await client.postMessage({
      body: 'Tests failing on payments',
      title: 'CI',
      sender: 'codex',
      project: 'shop',
      urgent: true,
    });
    expect(deploy).toMatchObject({ kind: 'note', state: 'unread', urgent: false, sender: 'claude-code', project: 'shop' });
    expect(failing).toMatchObject({ title: 'CI', urgent: true });
    expect(newEvents.map((m) => m.id)).toEqual([deploy.id, failing.id]);

    expect((await client.listMessages()).map((m) => m.id)).toEqual([failing.id, deploy.id]);
    expect((await client.listMessages({ q: 'deploy' })).map((m) => m.id)).toEqual([deploy.id]);
    expect((await client.listMessages({ q: 'ci payments' })).map((m) => m.id)).toEqual([failing.id]);

    const until = Date.now() + 3_600_000;
    expect(await client.snooze(failing.id, until)).toMatchObject({ state: 'snoozed', snoozedUntil: until });
    const done = await client.markDone(deploy.id);
    expect(done.state).toBe('done');
    expect(done.doneAt).toEqual(expect.any(Number));

    expect(await client.listMessages({ state: 'unread' })).toEqual([]);
    expect((await client.listMessages({ state: 'done', q: 'build' })).map((m) => m.id)).toEqual([deploy.id]);
    expect((await client.listMessages({ kind: 'note', state: 'snoozed' })).map((m) => m.id)).toEqual([failing.id]);
  });

  it('creates, lists and cancels reminders', async () => {
    const created: unknown[] = [];
    const cancelled: unknown[] = [];
    core.bus.on('reminder:created', (r) => created.push(r));
    core.bus.on('reminder:cancelled', (r) => cancelled.push(r));

    const weekly = await client.createReminder({
      body: 'Weekly review',
      when: '2099-01-05T09:00:00',
      rrule: 'FREQ=WEEKLY;BYDAY=MO',
      sender: 'claude-code',
      project: 'shop',
    });
    const once = await client.createReminder({ body: 'Call Bob', when: '2099-01-02T15:30:00Z', sender: 'claude-code' });
    expect(weekly).toMatchObject({ active: true, rrule: 'FREQ=WEEKLY;BYDAY=MO', dueAt: new Date(2099, 0, 5, 9).getTime() });
    expect(once.dueAt).toBe(Date.UTC(2099, 0, 2, 15, 30));
    expect((await client.listReminders()).map((r) => r.id)).toEqual([once.id, weekly.id]);

    await client.cancelReminder(once.id);
    expect((await client.listReminders()).map((r) => r.id)).toEqual([weekly.id]);
    expect(created).toHaveLength(2);
    expect(cancelled).toEqual([expect.objectContaining({ id: once.id, active: false })]);

    await expect(client.cancelReminder('01ARZ3NDEKTSV4RRFFQ69G5FAV')).rejects.toMatchObject({ status: 404 });
    await expect(client.createReminder({ body: 'x', when: '2099-01-02T15:30:00Z', rrule: 'nope', sender: 's' })).rejects.toBeInstanceOf(
      ClippyApiError,
    );
  });

  it('a reminder due now fires through the real scheduler', async () => {
    const fired = new Promise<CoreEventMap['reminder:fired']>((resolve) => core.bus.on('reminder:fired', resolve));
    const reminder = await client.createReminder({ body: 'Now!', when: new Date().toISOString(), sender: 'claude-code' });
    const { message } = await fired;
    expect(message).toMatchObject({ kind: 'reminder', body: 'Now!', state: 'unread' });
    expect(await client.listMessages({ kind: 'reminder' })).toEqual([message]);
    expect(await client.listReminders()).toEqual([]);
    expect(core.store.getReminder(reminder.id)).toMatchObject({ active: false, lastFiredAt: expect.any(Number) });
  });

  it('ask → long-poll → answer from another client; double answer is 409', async () => {
    const answeredEvents: CoreEventMap['ask:answered'][] = [];
    core.bus.on('ask:answered', (e) => answeredEvents.push(e));

    const ask = await client.createAsk({ question: 'Ship it?', options: ['yes', 'no'], sender: 'claude-code', project: 'shop' });
    expect(ask).toMatchObject({ kind: 'ask', body: 'Ship it?', options: ['yes', 'no'], state: 'unread' });
    expect((await client.listPendingAsks()).map((m) => m.id)).toEqual([ask.id]);
    expect(await client.waitAsk(ask.id, 0)).toEqual({ id: ask.id, status: 'pending' });

    const waiting = client.waitAsk(ask.id, 600);
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(1));
    const other = await ClippyClient.fromAppData();
    const result = await other.answerAsk(ask.id, 'yes', 'whatsapp');
    expect(result).toEqual({ id: ask.id, status: 'answered', answer: 'yes', answeredVia: 'whatsapp' });
    expect(await waiting).toEqual(result);

    expect(await client.listPendingAsks()).toEqual([]);
    expect((await client.listMessages({ kind: 'ask', state: 'done' }))[0]).toMatchObject({ answer: 'yes', answeredVia: 'whatsapp' });
    expect(answeredEvents).toHaveLength(1);

    const second = client.answerAsk(ask.id, 'no', 'desk');
    await expect(second).rejects.toBeInstanceOf(ClippyApiError);
    await expect(second).rejects.toMatchObject({ status: 409 });
  });

  it('waitAsk returns pending when nobody answers in time', async () => {
    const ask = await client.createAsk({ question: 'Anyone?', sender: 'codex' });
    expect(await client.waitAsk(ask.id, 1)).toEqual({ id: ask.id, status: 'pending' });
  });

  it('rejects a client with the wrong token (401)', async () => {
    const intruder = new ClippyClient({ baseUrl: client.baseUrl, token: 'f'.repeat(64) });
    await expect(intruder.health()).rejects.toMatchObject({ name: 'ClippyApiError', status: 401 });
  });

  it('after stop, fromAppData reports the app is not running', async () => {
    await core.stop();
    await expect(ClippyClient.fromAppData()).rejects.toBeInstanceOf(ClippyNotRunningError);
  });
});
