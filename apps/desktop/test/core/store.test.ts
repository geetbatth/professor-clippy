import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Message, Reminder, StandingOrder, Watch } from '@clippy/shared';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bus, type CoreEventMap } from '../../src/main/core/bus';
import { Store, toFtsQuery } from '../../src/main/core/store';
import { FakeClock } from './fakeClock';

const T0 = Date.UTC(2026, 9, 30, 9, 0, 0);

describe('Store', () => {
  let clock: FakeClock;
  let bus: Bus;
  let store: Store;
  let events: [keyof CoreEventMap, unknown][];

  beforeEach(() => {
    clock = new FakeClock(T0);
    bus = new Bus();
    events = [];
    bus.on('message:new', (m) => events.push(['message:new', m]));
    bus.on('message:updated', (m) => events.push(['message:updated', m]));
    store = new Store({ path: ':memory:', bus, clock });
  });

  afterEach(() => store.close());

  it('creates a message that matches the shared schema and emits message:new', () => {
    const m = store.createMessage({ kind: 'note', body: 'Build finished', sender: 'claude-code', project: 'clippy' });
    expect(Message.parse(m)).toEqual(m);
    expect(m).toEqual({
      id: expect.any(String),
      kind: 'note',
      body: 'Build finished',
      sender: 'claude-code',
      project: 'clippy',
      urgent: false,
      state: 'unread',
      createdAt: T0,
    });
    expect(events).toEqual([['message:new', m]]);
    expect(store.getMessage(m.id)).toEqual(m);
  });

  it('round-trips every optional field', () => {
    const m = store.createMessage({
      kind: 'ask',
      body: 'Deploy now?',
      title: 'Deploy',
      sender: 'codex',
      urgent: true,
      options: ['yes', 'no'],
      role: 'clippy',
      missed: false,
      waId: 'wamid.1',
    });
    const updated = store.updateMessage(m.id, { answer: 'yes', answeredVia: 'whatsapp', state: 'done', doneAt: T0 + 5 });
    expect(updated).toEqual({
      ...m,
      answer: 'yes',
      answeredVia: 'whatsapp',
      state: 'done',
      doneAt: T0 + 5,
    });
    expect(Message.parse(updated)).toEqual(updated);
    expect(store.findMessageByWaId('wamid.1')?.id).toBe(m.id);
    expect(store.findMessageByWaId('nope')).toBeUndefined();
  });

  it('ids are ULIDs that sort in creation order, even within one millisecond', () => {
    const ids = Array.from({ length: 5 }, (_, i) => store.createMessage({ kind: 'note', body: `n${i}`, sender: 's' }).id);
    expect([...ids].sort()).toEqual(ids);
  });

  it('lists newest first and filters by state and kind', () => {
    const a = store.createMessage({ kind: 'note', body: 'a', sender: 's' });
    clock.advance(1000);
    const b = store.createMessage({ kind: 'ask', body: 'b', sender: 's' });
    clock.advance(1000);
    const c = store.createMessage({ kind: 'note', body: 'c', sender: 's' });
    store.markDone(a.id);

    expect(store.listMessages().map((m) => m.body)).toEqual(['c', 'b', 'a']);
    expect(store.listMessages({ state: 'unread' }).map((m) => m.id)).toEqual([c.id, b.id]);
    expect(store.listMessages({ kind: 'note' }).map((m) => m.id)).toEqual([c.id, a.id]);
    expect(store.listMessages({ state: 'done', kind: 'note' }).map((m) => m.id)).toEqual([a.id]);
  });

  it('markDone and snooze update state and emit message:updated', () => {
    const m = store.createMessage({ kind: 'reminder', body: 'stretch', sender: 's' });
    clock.advance(10);
    const snoozed = store.snooze(m.id, T0 + 60_000)!;
    expect(snoozed).toMatchObject({ state: 'snoozed', snoozedUntil: T0 + 60_000 });
    expect(store.nextSnoozeWake()).toBe(T0 + 60_000);
    expect(store.listExpiredSnoozes(T0 + 59_999)).toEqual([]);
    expect(store.listExpiredSnoozes(T0 + 60_000).map((x) => x.id)).toEqual([m.id]);

    const done = store.markDone(m.id)!;
    expect(done.state).toBe('done');
    expect(done.doneAt).toBe(T0 + 10);
    expect(done.snoozedUntil).toBeUndefined();
    expect(store.nextSnoozeWake()).toBeUndefined();
    expect(events.map(([e]) => e)).toEqual(['message:new', 'message:updated', 'message:updated']);

    expect(store.markDone('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBeUndefined();
    expect(store.snooze('01ARZ3NDEKTSV4RRFFQ69G5FAV', 1)).toBeUndefined();
  });

  it('lists unanswered asks only', () => {
    const q1 = store.createMessage({ kind: 'ask', body: 'q1', sender: 's' });
    const q2 = store.createMessage({ kind: 'ask', body: 'q2', sender: 's' });
    store.createMessage({ kind: 'note', body: 'n', sender: 's' });
    store.updateMessage(q1.id, { answer: 'x', answeredVia: 'desk' });
    expect(store.listPendingAsks().map((m) => m.id)).toEqual([q2.id]);
  });

  describe('full-text search', () => {
    beforeEach(() => {
      store.createMessage({ kind: 'note', body: 'Deployment to production finished', sender: 's', title: 'Release' });
      clock.advance(1);
      store.createMessage({ kind: 'note', body: 'Tests failed on the payments service', sender: 's' });
      clock.advance(1);
      store.createMessage({ kind: 'reminder', body: 'Pay the café bill', sender: 's' });
    });

    const search = (q: string, extra = {}): string[] => store.listMessages({ q, ...extra }).map((m) => m.body);

    it('matches words by prefix, across body and title', () => {
      expect(search('deploy')).toEqual(['Deployment to production finished']);
      expect(search('release')).toEqual(['Deployment to production finished']);
      expect(search('pay')).toEqual(['Pay the café bill', 'Tests failed on the payments service']);
    });

    it('ANDs words, ignores case and diacritics', () => {
      expect(search('PAY service')).toEqual(['Tests failed on the payments service']);
      expect(search('cafe')).toEqual(['Pay the café bill']);
    });

    it('combines with state/kind filters', () => {
      expect(search('pay', { kind: 'reminder' })).toEqual(['Pay the café bill']);
      expect(search('pay', { state: 'done' })).toEqual([]);
    });

    it('treats FTS syntax as plain text instead of failing', () => {
      expect(search('"payments" (service:*')).toEqual(['Tests failed on the payments service']);
      expect(search('NEAR(')).toEqual([]);
      expect(search('***')).toEqual([]);
      expect(search('   ')).toHaveLength(3);
    });

    it('still finds a message after its state changes', () => {
      const m = store.listMessages({ q: 'deploy' })[0]!;
      store.markDone(m.id);
      expect(store.listMessages({ q: 'deploy', state: 'done' }).map((x) => x.id)).toEqual([m.id]);
    });
  });

  it('toFtsQuery quotes each word as a prefix term', () => {
    expect(toFtsQuery('foo "bar" baz-qux')).toBe('"foo"* "bar"* "baz"* "qux"*');
    expect(toFtsQuery('!!')).toBeUndefined();
  });

  it('stores reminders and returns them per the shared schema', () => {
    const base = { body: 'standup', sender: 's', active: true, createdAt: T0, startAt: T0 };
    store.insertReminder({ ...base, id: '01ARZ3NDEKTSV4RRFFQ69G5FA1', dueAt: T0 + 2000, rrule: 'FREQ=DAILY', project: 'p' });
    store.insertReminder({ ...base, id: '01ARZ3NDEKTSV4RRFFQ69G5FA2', dueAt: T0 + 1000 });
    store.insertReminder({ ...base, id: '01ARZ3NDEKTSV4RRFFQ69G5FA3', dueAt: T0, active: false });

    const active = store.listActiveReminders();
    expect(active.map((r) => r.id)).toEqual(['01ARZ3NDEKTSV4RRFFQ69G5FA2', '01ARZ3NDEKTSV4RRFFQ69G5FA1']);
    for (const r of active) expect(Reminder.parse(r)).toEqual(r);
    expect(active[1]).toEqual({
      id: '01ARZ3NDEKTSV4RRFFQ69G5FA1',
      body: 'standup',
      sender: 's',
      project: 'p',
      dueAt: T0 + 2000,
      rrule: 'FREQ=DAILY',
      active: true,
      createdAt: T0,
    });
    expect(store.nextReminderDue()).toBe(T0 + 1000);
    expect(store.listDueReminders(T0 + 1000)).toEqual([{ ...active[0], startAt: T0 }]);

    const updated = store.updateReminder('01ARZ3NDEKTSV4RRFFQ69G5FA2', { active: false, lastFiredAt: T0 + 1000 });
    expect(updated).toMatchObject({ active: false, lastFiredAt: T0 + 1000 });
    expect(store.nextReminderDue()).toBe(T0 + 2000);
    expect(store.getReminder('01ARZ3NDEKTSV4RRFFQ69G5FA9')).toBeUndefined();
  });

  it('transaction() emits events only after commit and drops them on rollback', () => {
    const inside: number[] = [];
    const result = store.transaction(() => {
      store.createMessage({ kind: 'note', body: 'committed', sender: 's' });
      inside.push(events.length);
      return 42;
    });
    expect(result).toBe(42);
    expect(inside).toEqual([0]);
    expect(events.map(([e]) => e)).toEqual(['message:new']);

    expect(() =>
      store.transaction(() => {
        store.createMessage({ kind: 'note', body: 'rolled back', sender: 's' });
        throw new Error('nope');
      }),
    ).toThrow('nope');
    expect(events).toHaveLength(1);
    expect(store.listMessages().map((m) => m.body)).toEqual(['committed']);
    expect(store.listMessages({ q: 'rolled' })).toEqual([]);
  });

  it('transaction() is usable again after BEGIN itself throws', () => {
    const exec = vi.spyOn(DatabaseSync.prototype, 'exec');
    exec.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    expect(() => store.transaction(() => 1)).toThrow('database is locked');
    exec.mockRestore();
    // Before the fix the deferred-event list stayed set and every later call said "not reentrant".
    expect(store.transaction(() => store.createMessage({ kind: 'note', body: 'after', sender: 's' }).body)).toBe('after');
    expect(events.map(([e]) => e)).toEqual(['message:new']);
  });

  it('creates messages in a given state and links reminder messages to their reminder', () => {
    const chat = store.createMessage({ kind: 'chat', role: 'user', body: 'hi', sender: 'user', state: 'done' });
    expect(chat).toMatchObject({ state: 'done', doneAt: T0 });
    expect(Message.parse(chat)).toEqual(chat);
    expect(store.findLatestReminderMessage('R1')).toBeUndefined();
    const first = store.createMessage({ kind: 'reminder', body: 'stretch', sender: 's', reminderId: 'R1' });
    clock.advance(1000);
    const second = store.createMessage({ kind: 'reminder', body: 'stretch', sender: 's', reminderId: 'R1' });
    store.createMessage({ kind: 'reminder', body: 'other', sender: 's', reminderId: 'R2' });
    expect(store.findLatestReminderMessage('R1')?.id).toBe(second.id);
    expect(first).not.toHaveProperty('reminderId'); // internal link, not part of the shared Message
  });

  it('has a key/value table', () => {
    expect(store.getKv('session')).toBeUndefined();
    store.setKv('session', 'abc');
    store.setKv('session', 'def');
    expect(store.getKv('session')).toBe('def');
    store.deleteKv('session');
    expect(store.getKv('session')).toBeUndefined();
  });
});

describe('Store on disk', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'clippy-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('migrates once and persists data and the FTS index across reopen', () => {
    const path = join(dir, 'clippy.db');
    const first = new Store({ path });
    expect(first.schemaVersion).toBe(6);
    const m = first.createMessage({ kind: 'note', body: 'persist me please', sender: 's' });
    first.close();

    const second = new Store({ path });
    expect(second.schemaVersion).toBe(6);
    expect(second.getMessage(m.id)).toEqual(m);
    expect(second.listMessages({ q: 'persist' }).map((x) => x.id)).toEqual([m.id]);
    second.close();
  });

  it('upgrades a version-1 database (adds the reminder link column) without losing data', () => {
    const path = join(dir, 'v1.db');
    const v1 = new DatabaseSync(path);
    v1.exec(`CREATE TABLE messages (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, body TEXT NOT NULL,
      title TEXT, sender TEXT NOT NULL, project TEXT, urgent INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      created_at INTEGER NOT NULL, done_at INTEGER, snoozed_until INTEGER, wa_id TEXT, options TEXT, answer TEXT,
      answered_via TEXT, role TEXT, missed INTEGER);
      CREATE VIRTUAL TABLE messages_fts USING fts5(title, body, content = 'messages', content_rowid = 'seq');
      CREATE TABLE reminders (id TEXT PRIMARY KEY, body TEXT NOT NULL, sender TEXT NOT NULL, project TEXT,
        start_at INTEGER NOT NULL, due_at INTEGER NOT NULL, rrule TEXT, active INTEGER NOT NULL,
        created_at INTEGER NOT NULL, last_fired_at INTEGER);
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO messages (id, kind, body, sender, state, created_at) VALUES ('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'note', 'old', 's', 'unread', 1);
      PRAGMA user_version = 1;`);
    v1.close();
    const store = new Store({ path });
    expect(store.schemaVersion).toBe(6);
    expect(store.getMessage('01ARZ3NDEKTSV4RRFFQ69G5FAV')?.body).toBe('old');
    store.createMessage({ kind: 'reminder', body: 'new', sender: 's', reminderId: 'R' });
    expect(store.findLatestReminderMessage('R')?.body).toBe('new');
    store.close();
  });

  it('stores and finds the Telegram message id (version 3), and clears it with null', () => {
    const store = new Store({ path: join(dir, 'tg.db') });
    const old = store.createMessage({ kind: 'note', body: 'before Telegram', sender: 's' });
    expect(old).not.toHaveProperty('tgMsgId');
    const m = store.createMessage({ kind: 'ask', body: 'Ship?', sender: 's', tgMsgId: 7 });
    expect(m.tgMsgId).toBe(7);
    expect(store.findMessageByTgMsgId(7)?.id).toBe(m.id);
    expect(store.updateMessage(old.id, { tgMsgId: 8 })?.tgMsgId).toBe(8);
    expect(store.updateMessage(old.id, { tgMsgId: null })).not.toHaveProperty('tgMsgId');
    expect(store.findMessageByTgMsgId(8)).toBeUndefined();
    store.updateMessage(old.id, { tgMsgId: 9 });
    expect(store.clearTgMsgIds()).toBe(2);
    expect(store.findMessageByTgMsgId(7)).toBeUndefined();
    expect(store.getMessage(m.id)).not.toHaveProperty('tgMsgId');
    store.close();
  });

  it('stores away-only notes (version 4)', () => {
    const store = new Store({ path: join(dir, 'quiet.db') });
    const quiet = store.createMessage({ kind: 'note', body: 'agent finished', sender: 'claude-code', quietIfActive: true, state: 'done' });
    expect(quiet).toMatchObject({ quietIfActive: true, state: 'done' });
    expect(store.createMessage({ kind: 'note', body: 'normal', sender: 's' })).not.toHaveProperty('quietIfActive');
    store.close();
  });

  it('stores, lists oldest first, and cancels standing orders (version 5)', () => {
    const clock = new FakeClock(T0);
    const store = new Store({ path: join(dir, 'orders.db'), clock });
    const first = store.insertOrder('When an agent asks which branch, answer: staging');
    clock.advance(1000);
    const second = store.insertOrder('When an agent asks to run the tests, answer: yes');
    expect(first).toMatchObject({ text: 'When an agent asks which branch, answer: staging', active: true, createdAt: T0 });
    expect(StandingOrder.parse(first)).toEqual(first);
    expect(store.listActiveOrders().map((o) => o.id)).toEqual([first.id, second.id]);

    expect(store.cancelOrder(first.id)).toMatchObject({ id: first.id, active: false });
    expect(store.listActiveOrders().map((o) => o.id)).toEqual([second.id]);
    expect(store.cancelOrder('01JB2Z3K4M5N6P7Q8R9S0T1V2Z')).toBeUndefined();
    store.close();
  });

  it('stores an ask that an order answered', () => {
    const clock = new FakeClock(T0);
    const store = new Store({ path: join(dir, 'auto.db'), clock });
    const order = store.insertOrder('say yes');
    const m = store.createMessage({
      kind: 'ask',
      body: 'Run the tests?',
      sender: 'claude-code',
      state: 'done',
      answer: 'yes',
      answeredVia: 'clippy',
      orderId: order.id,
    });
    expect(m).toMatchObject({ state: 'done', answer: 'yes', answeredVia: 'clippy', orderId: order.id, doneAt: T0 });
    expect(store.getMessage(m.id)).toEqual(m);
    expect(store.listPendingAsks()).toEqual([]);
    expect(store.createMessage({ kind: 'ask', body: 'q', sender: 's' })).not.toHaveProperty('orderId');
    store.close();
  });

  it('stores, lists oldest first, fires and cancels watches (version 6)', () => {
    const clock = new FakeClock(T0);
    const store = new Store({ path: join(dir, 'watches.db'), clock });
    const first = store.insertWatch({ project: 'payments', event: 'finished', nudge: 'Deploy' });
    clock.advance(1000);
    const second = store.insertWatch({ event: 'any', nudge: 'Look' });
    expect(first).toEqual({ id: first.id, project: 'payments', event: 'finished', nudge: 'Deploy', active: true, createdAt: T0 });
    expect(Watch.parse(first)).toEqual(first);
    expect(second).not.toHaveProperty('project');
    expect(store.listActiveWatches().map((w) => w.id)).toEqual([first.id, second.id]);

    expect(store.fireWatch(first.id, T0 + 5)).toBe(true);
    expect(store.fireWatch(first.id, T0 + 9)).toBe(false); // fires once
    expect(store.listActiveWatches().map((w) => w.id)).toEqual([second.id]);
    expect(store.cancelWatch(second.id)).toMatchObject({ id: second.id, active: false });
    expect(store.cancelWatch(second.id)).not.toHaveProperty('firedAt');
    expect(store.fireWatch(second.id, T0 + 9)).toBe(false); // a cancelled watch never fires
    expect(store.listActiveWatches()).toEqual([]);
    expect(store.cancelWatch('01JB2Z3K4M5N6P7Q8R9S0T1V2Z')).toBeUndefined();
    store.close();
  });

  it('stores what a note is about', () => {
    const store = new Store({ path: join(dir, 'event.db') });
    const m = store.createMessage({ kind: 'note', body: 'done', sender: 'claude-code', event: 'agent-finished' });
    expect(m.event).toBe('agent-finished');
    expect(store.getMessage(m.id)).toEqual(m);
    expect(store.createMessage({ kind: 'note', body: 'plain', sender: 's' })).not.toHaveProperty('event');
    store.close();
  });

  it('upgrades a version-4 database (adds standing orders) without losing data', () => {
    const path = join(dir, 'v4.db');
    const old = new Store({ path });
    const m = old.createMessage({ kind: 'ask', body: 'Ship it?', sender: 's' });
    old.close();
    // Rewind to what a version-4 database looks like: no orders table, no order_id column.
    const db = new DatabaseSync(path);
    db.exec('DROP TABLE watches; ALTER TABLE messages DROP COLUMN event; DROP TABLE standing_orders; ALTER TABLE messages DROP COLUMN order_id; PRAGMA user_version = 4;');
    db.close();

    const store = new Store({ path });
    expect(store.schemaVersion).toBe(6);
    expect(store.getMessage(m.id)).toEqual(m);
    expect(store.insertOrder('say yes').text).toBe('say yes');
    expect(store.getMessage(m.id)).not.toHaveProperty('orderId');
    store.close();
  });
});
