import { BRAIN_SENDER, type Message, type Reminder } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIEF_TITLE, BriefScheduler, CATCH_UP_MS, composeBrief, DEFAULT_LOOKBACK_MS, localDate } from '../src/main/brief';
import { Bus } from '../src/main/core/bus';
import { Store } from '../src/main/core/store';
import { FakeClock } from './core/fakeClock';

// Local-time dates, so the tests hold in any time zone. 30 Oct 2026 is a Friday.
const at = (day: number, h: number, m = 0) => new Date(2026, 9, day, h, m).getTime();
const HOUR = 60 * 60 * 1000;
const FRIDAY = 30;
const SATURDAY = 31;
const ULID = '01JB2Z3K4M5N6P7Q8R9S0T1V2A';

const reminder = (over: Partial<Reminder>): Reminder => ({
  id: ULID,
  body: 'x',
  sender: 'me',
  dueAt: at(FRIDAY, 12),
  active: true,
  createdAt: 1,
  ...over,
});
const message = (over: Partial<Message>): Message => ({
  id: ULID,
  kind: 'note',
  body: 'b',
  sender: 'claude-code',
  state: 'unread',
  urgent: false,
  createdAt: 1,
  ...over,
});
const compose = (over: Partial<Parameters<typeof composeBrief>[0]> = {}) =>
  composeBrief({ now: at(FRIDAY, 9), reminders: [], pendingAsks: [], unread: [], activity: [], ...over });

describe('composeBrief', () => {
  it('lists today\'s reminders as "• HH:MM body", soonest first, and leaves out tomorrow\'s', () => {
    const { title, body } = compose({
      reminders: [
        reminder({ body: 'Stand-up', dueAt: at(FRIDAY, 14, 5) }),
        reminder({ body: 'Pay rent', dueAt: at(FRIDAY, 9, 30) }),
        reminder({ body: 'Dentist', dueAt: at(SATURDAY, 8) }),
        reminder({ body: 'Cancelled', dueAt: at(FRIDAY, 10), active: false }),
      ],
    });
    expect(title).toBe('☀️ Morning brief');
    expect(title).toBe(BRIEF_TITLE);
    expect(body).toBe('Today:\n• 09:30 Pay rent\n• 14:05 Stand-up');
  });

  it('says so when there are no reminders but something else to report', () => {
    expect(compose({ unread: [message({})] }).body).toBe('No reminders today.\nUnread: 1 note');
  });

  it('names the questions waiting on the user', () => {
    const body = compose({ pendingAsks: [message({ kind: 'ask', body: 'a' }), message({ kind: 'ask', body: 'b' })] }).body;
    expect(body).toContain('Waiting on you: 2 questions (a, b)');
    const many = ['a', 'b', 'c', 'd', 'e'].map((body) => message({ kind: 'ask', body }));
    expect(compose({ pendingAsks: many }).body).toContain('Waiting on you: 5 questions (a, b, c, and 2 more)');
    const long = compose({ pendingAsks: [message({ kind: 'ask', body: `${'q'.repeat(80)}\nsecond line` })] }).body;
    expect(long).toContain(`(${'q'.repeat(39)}…)`);
  });

  it('does not count a question that was dismissed or answered', () => {
    const body = compose({
      pendingAsks: [
        message({ kind: 'ask', body: 'open' }),
        message({ kind: 'ask', body: 'dismissed', state: 'done' }),
        message({ kind: 'ask', body: 'answered', answer: 'yes', state: 'done' }),
      ],
    }).body;
    expect(body).toContain('Waiting on you: 1 question (open)');
    expect(compose({ pendingAsks: [message({ kind: 'ask', state: 'done' })] }).body).toBe('Clear day: no reminders, nothing waiting on you.');
  });

  it('counts the unread notes, leaving questions to their own line', () => {
    const body = compose({
      unread: [message({}), message({}), message({ kind: 'reminder' }), message({ kind: 'ask' })],
    }).body;
    expect(body).toContain('Unread: 3 notes');
  });

  it('groups the overnight activity per project, leaving out chat and Clippy\'s own notes', () => {
    const finished = (project: string) => message({ project, event: 'agent-finished', state: 'done' });
    const { body } = compose({
      activity: [
        finished('professor-clippy'),
        finished('professor-clippy'),
        finished('professor-clippy'),
        message({ project: 'professor-clippy' }),
        message({ project: 'payments', kind: 'ask' }),
        message({ project: 'payments', event: 'agent-needs-permission' }),
        message({ kind: 'chat', sender: 'user', project: 'professor-clippy' }),
        message({ sender: 'clippy', project: 'professor-clippy', title: BRIEF_TITLE }),
        message({ sender: BRAIN_SENDER, project: 'professor-clippy' }),
        message({ kind: 'reminder', project: 'professor-clippy' }),
        message({ project: undefined }),
      ],
    });
    expect(body).toContain(
      'Overnight:\n• professor-clippy: agent finished 3×, 1 note\n• payments: 1 note, 1 question\n• other: 1 note',
    );
  });

  it('is one line when there is nothing at all', () => {
    expect(compose()).toEqual({ title: '☀️ Morning brief', body: 'Clear day: no reminders, nothing waiting on you.' });
    // Chat and Clippy's own notes alone are still nothing.
    expect(compose({ activity: [message({ kind: 'chat' }), message({ sender: 'clippy' })] }).body).toBe(
      'Clear day: no reminders, nothing waiting on you.',
    );
    // So are Clippy's own unread notes (yesterday's brief, a nudge, the brain's).
    const own = [message({ sender: 'clippy', title: BRIEF_TITLE }), message({ sender: 'clippy', title: '⏰ Nudge' }), message({ sender: BRAIN_SENDER })];
    expect(compose({ unread: own }).body).toBe('Clear day: no reminders, nothing waiting on you.');
    expect(compose({ unread: [...own, message({})] }).body).toContain('Unread: 1 note');
  });
});

describe('BriefScheduler', () => {
  let clock: FakeClock;
  let store: Store;
  let settings: { briefEnabled: boolean; briefTime: string; briefWeekdaysOnly: boolean };
  let sent: Message[];
  let scheduler: BriefScheduler;

  /** A fresh scheduler on the shared store and clock, as after an app restart. */
  const make = () => new BriefScheduler({ store, clock, settings: () => settings });
  const start = (now: number) => {
    clock.advanceTo(now);
    scheduler.start();
  };

  beforeEach(() => {
    clock = new FakeClock(at(FRIDAY - 1, 15));
    const bus = new Bus();
    store = new Store({ path: ':memory:', bus, clock });
    settings = { briefEnabled: true, briefTime: '09:00', briefWeekdaysOnly: true };
    sent = [];
    bus.on('message:new', (m) => {
      if (m.sender === 'clippy') sent.push(m);
    });
    scheduler = make();
  });
  afterEach(() => {
    scheduler.stop();
    store.close();
    vi.restoreAllMocks();
  });

  it('fires at 09:00, once, as a note from Clippy', () => {
    start(at(FRIDAY, 7));
    expect(sent).toEqual([]);
    clock.advanceTo(at(FRIDAY, 9));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'note', sender: 'clippy', title: '☀️ Morning brief', state: 'unread' });
    clock.advanceTo(at(FRIDAY, 20));
    expect(sent).toHaveLength(1);
    // The next one is tomorrow's weekday: Monday, not the weekend.
    clock.advanceTo(at(SATURDAY + 2, 9));
    expect(sent).toHaveLength(2);
    expect(store.getKv('briefLastDate')).toBe('2026-11-02');
  });

  it('keeps timers short, so a long wait is re-armed rather than lost', () => {
    start(at(FRIDAY, 7));
    expect(clock.nextAt).toBe(at(FRIDAY, 8));
    clock.advanceTo(at(FRIDAY, 8));
    expect(sent).toHaveLength(0);
    expect(clock.pending).toBe(1);
    expect(clock.nextAt).toBe(at(FRIDAY, 9));
  });

  it('sends at once when started a little after the time with no brief yet today', () => {
    start(at(FRIDAY, 10, 30));
    expect(sent).toHaveLength(1);
    expect(store.getKv('briefLastDate')).toBe(localDate(at(FRIDAY, 10, 30)));
  });

  it('catches up before noon even when the brief time was more than two hours ago', () => {
    start(at(FRIDAY, 11, 30));
    expect(sent).toHaveLength(1);
    expect(at(FRIDAY, 11, 30) - at(FRIDAY, 9)).toBeGreaterThan(CATCH_UP_MS - 1);
  });

  it('with a late brief time, catches up within two hours of it but not after', () => {
    settings.briefTime = '13:00';
    start(at(FRIDAY, 14, 30));
    expect(sent).toHaveLength(1);
    scheduler.stop();
    store.deleteKv('briefLastDate');
    scheduler = make();
    start(at(FRIDAY, 15, 30));
    expect(sent).toHaveLength(1); // no second one: the 15:30 start is past the window
    clock.advanceTo(at(FRIDAY + 3, 13));
    expect(sent).toHaveLength(2);
  });

  it('sends nothing when started after noon and more than two hours late, until tomorrow', () => {
    start(at(FRIDAY, 12, 30));
    expect(sent).toHaveLength(0);
    expect(at(FRIDAY, 12, 30) - at(FRIDAY, 9)).toBeGreaterThan(CATCH_UP_MS);
    clock.advanceTo(at(FRIDAY, 23));
    expect(sent).toHaveLength(0);
    // Tomorrow is a Saturday (weekdays only): the next brief is Monday.
    clock.advanceTo(at(SATURDAY + 2, 9));
    expect(sent).toHaveLength(1);
  });

  it('never sends a second brief the same day, on restart or on wake from sleep', () => {
    start(at(FRIDAY, 10, 30));
    expect(sent).toHaveLength(1);
    scheduler.onResume();
    scheduler.start();
    expect(sent).toHaveLength(1);
    scheduler.stop();
    scheduler = make();
    start(at(FRIDAY, 10, 45));
    scheduler.onResume();
    expect(sent).toHaveLength(1);
  });

  it('catches up on wake from sleep that began before the time', () => {
    start(at(FRIDAY, 7));
    clock.jump(2 * HOUR + 15 * 60 * 1000); // slept through 09:00, awake at 09:15
    scheduler.onResume();
    expect(sent).toHaveLength(1);
  });

  it('sends nothing on a weekend with weekdays only, and does on a weekend without it', () => {
    clock.advanceTo(at(SATURDAY, 9));
    scheduler.start();
    expect(sent).toHaveLength(0);
    clock.advanceTo(at(SATURDAY, 20));
    expect(sent).toHaveLength(0);

    scheduler.stop();
    settings.briefWeekdaysOnly = false;
    store.deleteKv('briefLastDate');
    scheduler = make();
    start(at(SATURDAY, 20));
    expect(sent).toHaveLength(0); // too late today...
    clock.advanceTo(at(SATURDAY + 1, 9));
    expect(sent).toHaveLength(1); // ...but Sunday gets one
  });

  it('sends nothing when the brief is switched off, and arms no timer', () => {
    settings.briefEnabled = false;
    start(at(FRIDAY, 9, 5));
    expect(sent).toHaveLength(0);
    expect(clock.pending).toBe(0);
    clock.advanceTo(at(FRIDAY + 3, 12));
    expect(sent).toHaveLength(0);
  });

  it('arms the new time on reschedule, without sending on the spot', () => {
    start(at(FRIDAY, 7));
    settings.briefTime = '07:30';
    scheduler.reschedule();
    expect(clock.nextAt).toBe(at(FRIDAY, 7, 30));
    clock.advanceTo(at(FRIDAY, 7, 30));
    expect(sent).toHaveLength(1);

    // Switching it off stops the timer; switching a time already past on today's date waits for tomorrow's.
    settings.briefEnabled = false;
    scheduler.reschedule();
    expect(clock.pending).toBe(0);
    settings.briefEnabled = true;
    settings.briefTime = '08:00';
    scheduler.reschedule();
    expect(sent).toHaveLength(1);
    clock.advanceTo(at(FRIDAY, 23));
    expect(sent).toHaveLength(1);
  });

  it('does nothing after stop(), and reschedule or onResume before start() do nothing either', () => {
    scheduler.reschedule();
    scheduler.onResume();
    expect(clock.pending).toBe(0);
    start(at(FRIDAY, 8));
    scheduler.stop();
    expect(clock.pending).toBe(0);
    clock.advanceTo(at(FRIDAY, 9, 30));
    scheduler.onResume();
    scheduler.reschedule();
    expect(sent).toHaveLength(0);
    expect(clock.pending).toBe(0);
  });

  it('puts the day into the brief: reminders, questions, unread and overnight activity since the last brief', () => {
    const t = (day: number, h: number) => clock.advanceTo(at(day, h));
    // Before any brief: the last 16 hours count, older things do not.
    store.createMessage({ kind: 'note', body: 'too old', sender: 'claude-code', project: 'old-project' });
    t(FRIDAY, 6);
    store.createMessage({ kind: 'note', body: 'done', sender: 'claude-code', project: 'professor-clippy', event: 'agent-finished', state: 'done' });
    store.createMessage({ kind: 'note', body: 'fyi', sender: 'claude-code', project: 'professor-clippy' });
    store.createMessage({ kind: 'chat', body: 'chatter', sender: 'user', role: 'user' });
    store.createMessage({ kind: 'ask', body: 'Ship it?', sender: 'claude-code', project: 'professor-clippy' });
    store.insertReminder({
      id: store.newId(),
      body: 'Stand-up',
      sender: 'me',
      dueAt: at(FRIDAY, 11),
      active: true,
      createdAt: clock.now(),
      startAt: at(FRIDAY, 11),
    });
    scheduler.start();
    t(FRIDAY, 9);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe(
      [
        'Today:',
        '• 11:00 Stand-up',
        'Waiting on you: 1 question (Ship it?)',
        'Unread: 2 notes',
        'Overnight:',
        '• professor-clippy: agent finished 1×, 1 note, 1 question',
      ].join('\n'),
    );
    expect(at(FRIDAY, 9) - DEFAULT_LOOKBACK_MS).toBeGreaterThan(at(FRIDAY - 1, 15));
    expect(store.getKv('briefLastAt')).toBe(String(at(FRIDAY, 9)));

    // The next brief starts counting from this one: the old activity, and the brief itself, are not repeated.
    t(FRIDAY + 3, 8);
    store.createMessage({ kind: 'note', body: 'new', sender: 'claude-code', project: 'payments' });
    t(FRIDAY + 3, 9);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.body).toContain('Overnight:\n• payments: 1 note');
    expect(sent[1]!.body).not.toContain('professor-clippy: agent finished');
  });

  it('leaves a question dismissed on the desk out of "Waiting on you"', () => {
    clock.advanceTo(at(FRIDAY, 7));
    const ask = store.createMessage({ kind: 'ask', body: 'Ship it?', sender: 'claude-code' });
    store.createMessage({ kind: 'ask', body: 'Which branch?', sender: 'claude-code' });
    store.markDone(ask.id);
    scheduler.start();
    clock.advanceTo(at(FRIDAY, 9));
    expect(sent[0]!.body).toContain('Waiting on you: 1 question (Which branch?)');
  });

  it('is a single clear-day line on an empty desk', () => {
    start(at(FRIDAY, 9));
    expect(sent[0]!.body).toBe('Clear day: no reminders, nothing waiting on you.');
  });

  it('records nothing and retries shortly when the note cannot be stored', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const create = vi.spyOn(store, 'createMessage').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    start(at(FRIDAY, 9));
    expect(create).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalled();
    expect(sent).toHaveLength(0);
    expect(store.getKv('briefLastDate')).toBeUndefined();
    clock.advance(30_000);
    expect(sent).toHaveLength(1);
    expect(store.getKv('briefLastDate')).toBe(localDate(at(FRIDAY, 9)));
  });
});
