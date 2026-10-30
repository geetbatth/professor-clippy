import { Message, Reminder, type NewReminderInput } from '@clippy/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Bus, type CoreEventMap } from '../../src/main/core/bus';
import { NotFoundError, ValidationError } from '../../src/main/core/errors';
import { MAX_ARM_MS, Scheduler } from '../../src/main/core/scheduler';
import { Store } from '../../src/main/core/store';
import { FakeClock } from './fakeClock';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Local wall-clock time → epoch ms (the scheduler works in local time). */
const local = (y: number, mo: number, d: number, h = 0, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime();
/** ISO string without offset = local time, as an agent would send. */
const isoLocal = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

// Friday 30 Oct 2026, 08:00 local.
const T0 = local(2026, 10, 30, 8);

function setup(start = T0) {
  const clock = new FakeClock(start);
  const bus = new Bus();
  const store = new Store({ path: ':memory:', bus, clock });
  const scheduler = new Scheduler({ store, bus, clock });
  const events: { event: keyof CoreEventMap; payload: unknown }[] = [];
  for (const event of ['message:new', 'message:updated', 'reminder:fired', 'reminder:created', 'reminder:cancelled'] as const) {
    bus.on(event, (payload) => events.push({ event, payload }));
  }
  const fired = (): CoreEventMap['reminder:fired'][] =>
    events.filter((e) => e.event === 'reminder:fired').map((e) => e.payload as CoreEventMap['reminder:fired']);
  const reminderMessages = (): Message[] => store.listMessages({ kind: 'reminder' });
  return { clock, bus, store, scheduler, events, fired, reminderMessages };
}

const input = (when: number, extra: Partial<NewReminderInput> = {}): NewReminderInput => ({
  body: 'Stand up and stretch',
  sender: 'claude-code',
  project: 'clippy',
  when: new Date(when).toISOString(),
  ...extra,
});

describe('Scheduler: one-off reminders', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.scheduler.start();
  });
  afterEach(() => {
    ctx.scheduler.stop();
    ctx.store.close();
  });

  it('fires exactly at the due time, creating a reminder message and emitting events', () => {
    const { clock, scheduler, store, events, fired } = ctx;
    const reminder = scheduler.create(input(T0 + 10 * MIN));
    expect(Reminder.parse(reminder)).toEqual(reminder);
    expect(reminder).toMatchObject({ dueAt: T0 + 10 * MIN, active: true, createdAt: T0, project: 'clippy' });
    expect(reminder.rrule).toBeUndefined();
    expect(events.map((e) => e.event)).toEqual(['reminder:created']);

    clock.advance(10 * MIN - 1);
    expect(fired()).toHaveLength(0);
    clock.advance(1);

    expect(fired()).toHaveLength(1);
    const { reminder: after, message } = fired()[0]!;
    expect(message).toEqual({
      id: expect.any(String),
      kind: 'reminder',
      body: 'Stand up and stretch',
      sender: 'claude-code',
      project: 'clippy',
      urgent: false,
      state: 'unread',
      createdAt: T0 + 10 * MIN,
    });
    expect(Message.parse(message)).toEqual(message);
    expect(after).toMatchObject({ id: reminder.id, active: false, lastFiredAt: T0 + 10 * MIN });
    expect(events.map((e) => e.event)).toEqual(['reminder:created', 'message:new', 'reminder:fired']);
    expect(scheduler.list()).toEqual([]);
    expect(store.getReminder(reminder.id)).toEqual(after);

    clock.advance(DAY);
    expect(fired()).toHaveLength(1);
  });

  it('fires a reminder whose time already passed immediately (not marked missed)', () => {
    const { clock, scheduler, fired } = ctx;
    const reminder = scheduler.create(input(T0 - HOUR));
    expect(reminder.dueAt).toBe(T0);
    clock.advance(0);
    expect(fired()).toHaveLength(1);
    expect(fired()[0]!.message.missed).toBeUndefined();
  });

  it('interprets a `when` without offset as local time', () => {
    const due = local(2026, 10, 30, 17, 30);
    expect(ctx.scheduler.create(input(due, { when: '2026-10-30T17:30' })).dueAt).toBe(due);
  });

  it('keeps a single timer, armed for the earliest reminder', () => {
    const { clock, scheduler } = ctx;
    scheduler.create(input(T0 + 3 * HOUR));
    scheduler.create(input(T0 + 20 * MIN));
    scheduler.create(input(T0 + HOUR));
    expect(clock.pending).toBe(1);
    expect(clock.nextAt).toBe(T0 + 20 * MIN);
    expect(scheduler.list().map((r) => r.dueAt)).toEqual([T0 + 20 * MIN, T0 + HOUR, T0 + 3 * HOUR]);
  });

  it('re-arms in slices for far-future reminders and still fires once, on time', () => {
    const { clock, scheduler, fired } = ctx;
    scheduler.create(input(T0 + 40 * DAY));
    expect(clock.nextAt).toBe(T0 + MAX_ARM_MS);
    clock.advance(40 * DAY - 1);
    expect(fired()).toHaveLength(0);
    clock.advance(1);
    expect(fired()).toHaveLength(1);
    expect(fired()[0]!.message.createdAt).toBe(T0 + 40 * DAY);
  });

  it('cancel stops a reminder from firing and emits reminder:cancelled', () => {
    const { clock, scheduler, events, fired } = ctx;
    const reminder = scheduler.create(input(T0 + MIN));
    const cancelled = scheduler.cancel(reminder.id);
    expect(cancelled).toMatchObject({ id: reminder.id, active: false });
    expect(events.at(-1)).toEqual({ event: 'reminder:cancelled', payload: cancelled });
    expect(scheduler.cancel(reminder.id)).toEqual(cancelled); // idempotent, no second event
    expect(events.filter((e) => e.event === 'reminder:cancelled')).toHaveLength(1);
    clock.advance(HOUR);
    expect(fired()).toHaveLength(0);
    expect(clock.pending).toBe(0);
    expect(() => scheduler.cancel('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toThrow(NotFoundError);
  });

  it('rejects an unparseable `when`', () => {
    expect(() => ctx.scheduler.create({ ...input(T0), when: '2026-02-30T25:00:00Z' })).toThrow(ValidationError);
  });

  it('stop() disarms the timer', () => {
    const { clock, scheduler, fired } = ctx;
    scheduler.create(input(T0 + MIN));
    scheduler.stop();
    expect(clock.pending).toBe(0);
    clock.advance(HOUR);
    expect(fired()).toHaveLength(0);
  });
});

describe('Scheduler: recurring reminders', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
    ctx.scheduler.start();
  });
  afterEach(() => {
    ctx.scheduler.stop();
    ctx.store.close();
  });

  it('first fires on the first occurrence at/after `when`, then advances to the next', () => {
    const { clock, scheduler, fired } = ctx;
    // Friday 08:00 now; "Mondays and Wednesdays at 09:00" starting today at 09:00.
    const reminder = scheduler.create(input(local(2026, 10, 30, 9), { rrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE' }));
    expect(reminder.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,WE');
    expect(reminder.dueAt).toBe(local(2026, 11, 2, 9));

    clock.advanceTo(local(2026, 11, 2, 9));
    expect(fired()).toHaveLength(1);
    expect(fired()[0]!.reminder).toMatchObject({ active: true, dueAt: local(2026, 11, 4, 9), lastFiredAt: local(2026, 11, 2, 9) });
    expect(fired()[0]!.message.missed).toBeUndefined();

    clock.advanceTo(local(2026, 11, 4, 9));
    expect(fired()).toHaveLength(2);
    expect(scheduler.list()[0]!.dueAt).toBe(local(2026, 11, 9, 9));
  });

  it('a start in the past begins at the next future occurrence', () => {
    const reminder = ctx.scheduler.create(input(local(2026, 10, 1, 9), { rrule: 'FREQ=DAILY' }));
    expect(reminder.dueAt).toBe(local(2026, 10, 30, 9));
  });

  it('becomes inactive after its last occurrence (COUNT)', () => {
    const { clock, scheduler, fired } = ctx;
    scheduler.create(input(local(2026, 10, 30, 9), { rrule: 'FREQ=DAILY;COUNT=2' }));
    clock.advanceTo(local(2026, 10, 31, 9));
    expect(fired().map((f) => f.reminder.active)).toEqual([true, false]);
    expect(scheduler.list()).toEqual([]);
    clock.advance(10 * DAY);
    expect(fired()).toHaveLength(2);
  });

  it.each([
    ['garbage', /Invalid rrule/],
    ['BYDAY=MO', /FREQ is required/],
    ['FREQ=BOGUS', /Invalid rrule/],
    ['FREQ=DAILY;INTERVAL=x', /INTERVAL/],
    ['FREQ=SECONDLY', /SECONDLY/],
    ['FREQ=DAILY;UNTIL=20200101T000000Z', /no occurrences in the future/],
  ])('rejects rrule %s', (rrule, error) => {
    expect(() => ctx.scheduler.create(input(T0 + HOUR, { rrule }))).toThrow(error);
    expect(() => ctx.scheduler.create(input(T0 + HOUR, { rrule }))).toThrow(ValidationError);
  });
});

describe('Scheduler: catch-up after being stopped or asleep', () => {
  it('start() fires each overdue reminder once with missed: true and advances recurring ones', () => {
    const { clock, bus, store, scheduler, fired, reminderMessages } = setup();
    // Created while running, then the app quits.
    scheduler.start();
    const daily = scheduler.create(input(local(2026, 10, 30, 9), { rrule: 'FREQ=DAILY' }));
    const once = scheduler.create(input(local(2026, 10, 30, 12)));
    const future = scheduler.create(input(local(2026, 11, 20, 12)));
    scheduler.stop();

    // PC off for ~3.5 days: daily missed 4 times, the one-off once. Then the app starts again.
    clock.jump(local(2026, 11, 2, 20) - T0);
    const restarted = new Scheduler({ store, bus, clock });
    restarted.start();

    const messages = reminderMessages();
    expect(messages).toHaveLength(2);
    expect(messages.every((m) => m.missed === true && m.state === 'unread')).toBe(true);
    expect(fired().map((f) => f.reminder.id).sort()).toEqual([daily.id, once.id].sort());
    expect(store.getReminder(daily.id)).toMatchObject({ active: true, dueAt: local(2026, 11, 3, 9), lastFiredAt: local(2026, 11, 2, 20) });
    expect(store.getReminder(once.id)).toMatchObject({ active: false });
    expect(store.getReminder(future.id)).toMatchObject({ active: true, dueAt: local(2026, 11, 20, 12) });

    // Normal operation resumes: the next daily occurrence is on time.
    clock.advanceTo(local(2026, 11, 3, 9));
    expect(reminderMessages()).toHaveLength(3);
    expect(reminderMessages()[0]!.missed).toBeUndefined();
    restarted.stop();
    store.close();
  });

  it('onResume() catches up reminders that came due while asleep', () => {
    const { clock, store, scheduler, reminderMessages } = setup();
    scheduler.start();
    scheduler.create(input(T0 + HOUR));
    clock.jump(5 * HOUR); // asleep: the timer didn't run
    scheduler.onResume();
    expect(reminderMessages()).toEqual([expect.objectContaining({ missed: true, createdAt: T0 + 5 * HOUR })]);
    scheduler.stop();
    store.close();
  });

  it('a timer that runs long after the due time (sleep) also marks missed', () => {
    const { clock, store, scheduler, reminderMessages } = setup();
    scheduler.start();
    scheduler.create(input(T0 + HOUR));
    clock.jump(3 * HOUR);
    clock.advance(0); // the overdue timer finally runs, before any resume event
    expect(reminderMessages()).toEqual([expect.objectContaining({ missed: true })]);
    scheduler.onResume(); // nothing left to catch up
    expect(reminderMessages()).toHaveLength(1);
    scheduler.stop();
    store.close();
  });

  it('does not fire anything while stopped', () => {
    const { clock, store, scheduler, fired } = setup();
    scheduler.create(input(T0 + MIN)); // created while stopped: stored, not armed
    expect(clock.pending).toBe(0);
    scheduler.onResume(); // ignored while stopped
    clock.advance(HOUR);
    expect(fired()).toHaveLength(0);
    store.close();
  });
});

describe('Scheduler: snoozed messages', () => {
  it('wakes a snoozed message back to unread at snoozedUntil', () => {
    const { clock, store, scheduler, events } = setup();
    scheduler.start();
    const m = store.createMessage({ kind: 'reminder', body: 'stretch', sender: 's' });
    store.snooze(m.id, T0 + 10 * MIN); // e.g. via the API or IPC; the scheduler re-arms from the bus
    expect(clock.nextAt).toBe(T0 + 10 * MIN);

    clock.advance(10 * MIN - 1);
    expect(store.getMessage(m.id)!.state).toBe('snoozed');
    clock.advance(1);
    const woken = store.getMessage(m.id)!;
    expect(woken.state).toBe('unread');
    expect(woken.snoozedUntil).toBeUndefined();
    expect(events.at(-1)).toEqual({ event: 'message:updated', payload: woken });
    expect(clock.pending).toBe(0);
    scheduler.stop();
    store.close();
  });

  it('wakes snoozes that expired while stopped on start()', () => {
    const { clock, store, scheduler } = setup();
    const m = store.createMessage({ kind: 'note', body: 'later', sender: 's' });
    store.snooze(m.id, T0 + MIN);
    clock.jump(HOUR);
    scheduler.start();
    expect(store.getMessage(m.id)!.state).toBe('unread');
    scheduler.stop();
    store.close();
  });
});

describe('Scheduler: local time across DST', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York'; // DST ends Sun 1 Nov 2026
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('a daily 09:00 reminder stays at 09:00 local when the clocks change', () => {
    const start = Date.parse('2026-10-31T12:00:00Z'); // 08:00 EDT
    const { clock, store, scheduler, fired } = setup(start);
    scheduler.start();
    const reminder = scheduler.create(input(0, { when: '2026-10-31T09:00:00', rrule: 'FREQ=DAILY' }));
    expect(new Date(reminder.dueAt).toISOString()).toBe('2026-10-31T13:00:00.000Z'); // 09:00 EDT
    clock.advanceTo(reminder.dueAt);
    expect(new Date(fired()[0]!.reminder.dueAt).toISOString()).toBe('2026-11-01T14:00:00.000Z'); // 09:00 EST
    expect(isoLocal(fired()[0]!.reminder.dueAt)).toBe('2026-11-01T09:00:00');
    scheduler.stop();
    store.close();
  });
});
