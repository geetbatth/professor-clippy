import { describe, expect, it } from 'vitest';
import {
  AskResult,
  Message,
  MessageFilter,
  NewAskInput,
  NewMessageInput,
  NewReminderInput,
  NewStandingOrderInput,
  NewWatchInput,
  Reminder,
  StandingOrder,
  Watch,
} from '../src/schemas';

const ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2W';

const note = {
  id: ID,
  kind: 'note',
  body: 'Build finished: 3 tests failed',
  sender: 'claude-code',
  project: 'professor-clippy',
  urgent: false,
  state: 'unread',
  createdAt: 1_761_800_000_000,
} as const;

describe('Message', () => {
  it('accepts a minimal note', () => {
    expect(Message.parse(note)).toEqual(note);
  });

  it('accepts a fully populated answered ask', () => {
    const ask = {
      ...note,
      kind: 'ask',
      title: 'Question',
      state: 'done',
      doneAt: 1_761_800_100_000,
      waId: 'wamid.ABC',
      options: ['yes', 'no'],
      answer: 'yes',
      answeredVia: 'whatsapp',
    };
    expect(Message.parse(ask)).toEqual(ask);
  });

  it('accepts a Telegram-answered ask with its Telegram message id; older messages without one still parse', () => {
    const ask = { ...note, kind: 'ask', tgMsgId: 42, answer: 'yes', answeredVia: 'telegram' };
    expect(Message.parse(ask)).toEqual(ask);
    expect(Message.parse(note)).not.toHaveProperty('tgMsgId');
  });

  it('accepts chat lines with a role and missed reminders', () => {
    expect(Message.parse({ ...note, kind: 'chat', role: 'clippy' }).role).toBe('clippy');
    expect(Message.parse({ ...note, kind: 'reminder', missed: true }).missed).toBe(true);
  });

  it('keeps the body verbatim', () => {
    const body = '  *raw*  text\n\twith whitespace  ';
    expect(Message.parse({ ...note, body }).body).toBe(body);
  });

  it.each([
    ['non-ULID id', { id: 'abc' }],
    ['unknown kind', { kind: 'email' }],
    ['unknown state', { state: 'archived' }],
    ['missing urgent', { urgent: undefined }],
    ['fractional timestamp', { createdAt: 1.5 }],
    ['unknown answeredVia', { answeredVia: 'sms' }],
    ['unknown role', { role: 'agent' }],
  ])('rejects %s', (_label, patch) => {
    expect(Message.safeParse({ ...note, ...patch }).success).toBe(false);
  });
});

describe('Reminder', () => {
  it('accepts one-off and recurring reminders', () => {
    const base = { id: ID, body: 'Stand-up', sender: 'claude-code', dueAt: 1, active: true, createdAt: 0 };
    expect(Reminder.parse(base)).toEqual(base);
    const recurring = { ...base, project: 'p', rrule: 'FREQ=WEEKLY;BYDAY=MO', lastFiredAt: 2 };
    expect(Reminder.parse(recurring)).toEqual(recurring);
  });

  it('rejects a reminder without dueAt', () => {
    expect(Reminder.safeParse({ id: ID, body: 'x', sender: 's', active: true, createdAt: 0 }).success).toBe(false);
  });
});

describe('NewMessageInput', () => {
  it('needs body and sender; urgent is optional', () => {
    expect(NewMessageInput.parse({ body: 'hi', sender: 'a' })).toEqual({ body: 'hi', sender: 'a' });
    expect(NewMessageInput.safeParse({ body: '', sender: 'a' }).success).toBe(false);
    expect(NewMessageInput.safeParse({ body: 'hi' }).success).toBe(false);
  });

  it('takes an optional quietIfActive (away-only), also on the stored Message', () => {
    expect(NewMessageInput.parse({ body: 'hi', sender: 'a', quietIfActive: true })).toEqual({ body: 'hi', sender: 'a', quietIfActive: true });
    expect(NewMessageInput.safeParse({ body: 'hi', sender: 'a', quietIfActive: 'yes' }).success).toBe(false);
    expect(Message.parse({ ...note, quietIfActive: true }).quietIfActive).toBe(true);
    expect(Message.parse(note)).not.toHaveProperty('quietIfActive');
  });
});

describe('NewReminderInput', () => {
  const base = { body: 'Call the vet', sender: 'claude-code' };

  it.each([
    '2026-10-30T15:00:00Z',
    '2026-10-30T15:00:00+01:00',
    '2026-10-30T15:00:00.250Z',
    '2026-10-30T15:00',
    '2026-10-30T09:00Z',
    '2026-10-30T09:00-07:00',
    '2026-10-30T09:00+05:30',
  ])('accepts ISO 8601 when=%s', (when) => {
    expect(NewReminderInput.parse({ ...base, when }).when).toBe(when);
  });

  it.each([
    'tomorrow at 9',
    '2026-10-30',
    '2026-13-01T09:00:00Z',
    '',
    '2026-10-30T09Z',
    '2026-10-30T25:00Z',
    '2026-10-30T09:00+0700',
  ])('rejects when=%s', (when) => {
    expect(NewReminderInput.safeParse({ ...base, when }).success).toBe(false);
  });

  it('accepts an RRULE string', () => {
    const input = NewReminderInput.parse({ ...base, when: '2026-11-02T09:00:00Z', rrule: 'FREQ=DAILY' });
    expect(input.rrule).toBe('FREQ=DAILY');
  });
});

describe('NewAskInput / AskResult', () => {
  it('parses an ask with options', () => {
    const ask = { question: 'Deploy now?', options: ['yes', 'no'], sender: 'codex', urgent: true };
    expect(NewAskInput.parse(ask)).toEqual(ask);
    expect(NewAskInput.safeParse({ question: '', sender: 'codex' }).success).toBe(false);
  });

  it('parses pending and answered results', () => {
    expect(AskResult.parse({ id: ID, status: 'pending' })).toEqual({ id: ID, status: 'pending' });
    const answered = { id: ID, status: 'answered', answer: 'yes', answeredVia: 'desk' };
    expect(AskResult.parse(answered)).toEqual(answered);
    expect(AskResult.safeParse({ id: ID, status: 'timeout' }).success).toBe(false);
  });
});

describe('MessageFilter', () => {
  it('allows empty and full filters', () => {
    expect(MessageFilter.parse({})).toEqual({});
    const full = { state: 'done', kind: 'ask', q: 'deploy' };
    expect(MessageFilter.parse(full)).toEqual(full);
  });
});

describe('StandingOrder', () => {
  it('parses an order, and a message that an order answered', () => {
    const order = { id: ID, text: 'When an agent asks which branch, answer: staging', active: true, createdAt: 5 };
    expect(StandingOrder.parse(order)).toEqual(order);
    expect(StandingOrder.safeParse({ ...order, id: 'abc' }).success).toBe(false);
    expect(Message.parse({ ...note, orderId: ID }).orderId).toBe(ID);
    expect(Message.parse(note)).not.toHaveProperty('orderId');
  });

  it('takes 1 to 500 characters of text', () => {
    expect(NewStandingOrderInput.parse({ text: 'x' })).toEqual({ text: 'x' });
    expect(NewStandingOrderInput.safeParse({ text: '' }).success).toBe(false);
    expect(NewStandingOrderInput.safeParse({ text: 'x'.repeat(500) }).success).toBe(true);
    expect(NewStandingOrderInput.safeParse({ text: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('Watch', () => {
  it('parses a watch, with and without a project or a firing time', () => {
    const watch = { id: ID, project: 'payments', event: 'finished', nudge: 'Deploy to staging', active: true, createdAt: 5 };
    expect(Watch.parse(watch)).toEqual(watch);
    const fired = { id: ID, event: 'any', nudge: 'Look', active: false, createdAt: 5, firedAt: 9 };
    expect(Watch.parse(fired)).toEqual(fired);
    expect(Watch.safeParse({ ...watch, event: 'sometimes' }).success).toBe(false);
  });

  it('takes a nudge of 1 to 500 characters, an optional project of 1 to 200, and the finished or any event', () => {
    expect(NewWatchInput.parse({ nudge: 'x' })).toEqual({ nudge: 'x' });
    expect(NewWatchInput.parse({ project: 'api', event: 'any', nudge: 'x' })).toEqual({ project: 'api', event: 'any', nudge: 'x' });
    expect(NewWatchInput.safeParse({ nudge: '' }).success).toBe(false);
    expect(NewWatchInput.safeParse({ nudge: 'x'.repeat(501) }).success).toBe(false);
    expect(NewWatchInput.safeParse({ project: '', nudge: 'x' }).success).toBe(false);
    expect(NewWatchInput.safeParse({ project: 'p'.repeat(201), nudge: 'x' }).success).toBe(false);
    expect(NewWatchInput.safeParse({ event: 'done', nudge: 'x' }).success).toBe(false);
  });

  it('carries what a note is about on a message and its input', () => {
    expect(Message.parse({ ...note, event: 'agent-finished' }).event).toBe('agent-finished');
    expect(Message.parse(note)).not.toHaveProperty('event');
    expect(Message.safeParse({ ...note, event: 'nope' }).success).toBe(false);
  });
});
