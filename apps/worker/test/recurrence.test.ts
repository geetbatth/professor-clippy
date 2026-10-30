import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseRule } from '../src/recurrence';

const utc = (s: string) => Date.parse(s);

describe('nextOccurrence', () => {
  it('FREQ=DAILY keeps the anchor time of day', () => {
    const anchor = utc('2026-11-02T09:30:00Z');
    expect(nextOccurrence('FREQ=DAILY', anchor, anchor)).toBe(utc('2026-11-03T09:30:00Z'));
  });

  it('INTERVAL skips periods', () => {
    const anchor = utc('2026-11-02T09:30:00Z');
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', anchor, anchor)).toBe(utc('2026-11-05T09:30:00Z'));
  });

  it('FREQ=WEEKLY with BYDAY, BYHOUR and BYMINUTE (UTC)', () => {
    const anchor = utc('2026-11-02T08:00:00Z'); // Monday
    const rule = 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=15';
    expect(nextOccurrence(rule, anchor, anchor)).toBe(utc('2026-11-02T09:15:00Z'));
    expect(nextOccurrence(rule, anchor, utc('2026-11-02T09:15:00Z'))).toBe(utc('2026-11-04T09:15:00Z'));
    expect(nextOccurrence(rule, anchor, utc('2026-11-06T10:00:00Z'))).toBe(utc('2026-11-09T09:15:00Z'));
  });

  it('FREQ=MONTHLY on the anchor day', () => {
    const anchor = utc('2026-11-15T12:00:00Z');
    expect(nextOccurrence('FREQ=MONTHLY', anchor, anchor)).toBe(utc('2026-12-15T12:00:00Z'));
  });

  it('skips every occurrence missed while overdue (one firing, next in the future)', () => {
    const anchor = utc('2026-11-02T09:00:00Z');
    expect(nextOccurrence('FREQ=DAILY', anchor, utc('2026-11-10T13:00:00Z'))).toBe(utc('2026-11-11T09:00:00Z'));
  });

  it('accepts an RRULE: prefix and ignores a DTSTART line', () => {
    const anchor = utc('2026-11-02T09:00:00Z');
    expect(nextOccurrence('DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY', anchor, anchor)).toBe(
      utc('2026-11-03T09:00:00Z'),
    );
  });

  it('is undefined once COUNT or UNTIL is exhausted', () => {
    const anchor = utc('2026-11-02T09:00:00Z');
    expect(nextOccurrence('FREQ=DAILY;COUNT=2', anchor, anchor)).toBe(utc('2026-11-03T09:00:00Z'));
    expect(nextOccurrence('FREQ=DAILY;COUNT=2', anchor, utc('2026-11-03T09:00:00Z'))).toBeUndefined();
    expect(nextOccurrence('FREQ=DAILY;UNTIL=20261103T000000Z', anchor, anchor)).toBeUndefined();
  });
});

describe('parseRule', () => {
  it('rejects garbage and a missing FREQ', () => {
    expect(() => parseRule('', 0)).toThrow(/Invalid RRULE/);
    expect(() => parseRule('INTERVAL=2', 0)).toThrow(/FREQ is required/);
    expect(() => parseRule('FREQ=SOMETIMES', 0)).toThrow(/Invalid RRULE/);
  });
});
