import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  PcToWorker,
  RelayReminderPut,
  RelayRoutes,
  RelaySendRequest,
  RelaySendResponse,
  templateParam,
  WA_TEMPLATE_NAME,
  WA_TEMPLATE_PARAM_MAX,
  WA_TRUNCATION_SUFFIX,
  WorkerToPc,
} from '../src/relay';

describe('RelayRoutes', () => {
  it('matches the relay contract', () => {
    expect(Object.values(RelayRoutes).map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /send',
      'PUT /reminders/:id',
      'DELETE /reminders/:id',
      'GET /ws',
    ]);
  });
});

describe('REST bodies', () => {
  it('parses send request and response', () => {
    const req = { text: 'hi', kind: 'note', urgent: true };
    expect(RelaySendRequest.parse(req)).toEqual(req);
    expect(RelaySendRequest.safeParse({ text: 'hi', kind: 'sms' }).success).toBe(false);
    expect(RelaySendResponse.parse({ waId: 'wamid.1', mode: 'template' }).mode).toBe('template');
    expect(RelaySendResponse.safeParse({ waId: 'wamid.1', mode: 'sms' }).success).toBe(false);
  });

  it('parses a reminder put', () => {
    const put = { body: 'b', dueAt: 5, rrule: 'FREQ=DAILY' };
    expect(RelayReminderPut.parse(put)).toEqual(put);
    expect(RelayReminderPut.safeParse({ body: 'b' }).success).toBe(false);
  });

  it('accepts an IANA tz on a reminder put and rejects unknown zones', () => {
    const put = { body: 'b', dueAt: 5, rrule: 'FREQ=DAILY', tz: 'America/Los_Angeles' };
    expect(RelayReminderPut.parse(put)).toEqual(put);
    expect(RelayReminderPut.parse({ ...put, tz: 'UTC' }).tz).toBe('UTC');
    expect(RelayReminderPut.safeParse({ ...put, tz: 'Mars/Olympus_Mons' }).success).toBe(false);
    expect(RelayReminderPut.safeParse({ ...put, tz: '' }).success).toBe(false);
    expect(isValidTimeZone('Europe/London')).toBe(true);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
  });
});

describe('WebSocket frames', () => {
  it('discriminates Worker-to-PC frames by type', () => {
    const inbound = { type: 'inbound', id: 'd1', text: 'yes', contextWaId: 'wamid.9', ts: 1 };
    expect(WorkerToPc.parse(inbound)).toEqual(inbound);
    const fired = { type: 'reminder-fired', id: 'r1:2', reminderId: 'r1', firedAt: 2, waId: 'wamid.2', nextDueAt: 3 };
    expect(WorkerToPc.parse(fired)).toEqual(fired);
    expect(WorkerToPc.safeParse({ ...fired, reminderId: undefined }).success).toBe(false);
    expect(WorkerToPc.safeParse({ type: 'ack', ids: [] }).success).toBe(false);
    expect(WorkerToPc.safeParse({ type: 'inbound', id: 'd1', ts: 1 }).success).toBe(false);
  });

  it('parses PC-to-Worker acks', () => {
    expect(PcToWorker.parse({ type: 'ack', ids: ['d1', 'r1'] })).toEqual({ type: 'ack', ids: ['d1', 'r1'] });
    expect(PcToWorker.safeParse({ type: 'inbound' }).success).toBe(false);
  });
});

describe('WhatsApp template', () => {
  it('uses the agreed template name and suffix', () => {
    expect(WA_TEMPLATE_NAME).toBe('clippy_note');
    expect(WA_TEMPLATE_PARAM_MAX).toBe(1000);
    expect(WA_TRUNCATION_SUFFIX).toBe('…more on desktop');
  });

  it('leaves text that fits unchanged', () => {
    const exact = 'x'.repeat(WA_TEMPLATE_PARAM_MAX);
    expect(templateParam('short')).toBe('short');
    expect(templateParam(exact)).toBe(exact);
  });

  it('cuts long text to exactly the max, ending with the suffix', () => {
    const out = templateParam('y'.repeat(WA_TEMPLATE_PARAM_MAX + 1));
    expect(out).toHaveLength(WA_TEMPLATE_PARAM_MAX);
    expect(out.endsWith(WA_TRUNCATION_SUFFIX)).toBe(true);
  });

  it('never splits a surrogate pair', () => {
    const keep = WA_TEMPLATE_PARAM_MAX - WA_TRUNCATION_SUFFIX.length;
    const emoji = '\u{1F4CE}'; // paperclip, two UTF-16 code units
    const text = 'a'.repeat(keep - 1) + emoji + 'b'.repeat(50); // emoji straddles the cut
    expect(templateParam(text)).toBe('a'.repeat(keep - 1) + WA_TRUNCATION_SUFFIX);
  });
});
