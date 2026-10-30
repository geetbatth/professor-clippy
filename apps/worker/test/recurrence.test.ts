import { describe, expect, it } from 'vitest';
import { fromFloating, nextOccurrence, parseRuleOptions, toFloating, zoneOffset } from '../src/recurrence';

const utc = (s: string) => Date.parse(s);
const LA = 'America/Los_Angeles';

/** Weekday and HH:MM of instant `t` in Los Angeles. */
function laWall(t: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LA,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(t));
}

/** The next `n` occurrences, each strictly after the previous one. */
function series(rrule: string, dtstart: number, n: number, tz?: string): number[] {
  const out: number[] = [];
  let after = dtstart;
  for (let i = 0; i < n; i++) {
    const next = nextOccurrence(rrule, dtstart, after, tz);
    if (next === undefined) break;
    expect(next).toBeGreaterThan(after);
    out.push(next);
    after = next;
  }
  return out;
}

describe('nextOccurrence (UTC, no tz)', () => {
  it('FREQ=DAILY keeps the anchor time of day', () => {
    const anchor = utc('2026-11-02T09:30:00Z');
    expect(nextOccurrence('FREQ=DAILY', anchor, anchor)).toBe(utc('2026-11-03T09:30:00Z'));
  });

  it('INTERVAL skips periods', () => {
    const anchor = utc('2026-11-02T09:30:00Z');
    expect(nextOccurrence('FREQ=DAILY;INTERVAL=3', anchor, anchor)).toBe(utc('2026-11-05T09:30:00Z'));
  });

  it('FREQ=WEEKLY with BYDAY, BYHOUR and BYMINUTE', () => {
    const anchor = utc('2026-11-02T08:00:00Z'); // Monday
    const rule = 'FREQ=WEEKLY;BYDAY=MO,WE,FR;BYHOUR=9;BYMINUTE=15';
    expect(nextOccurrence(rule, anchor, anchor)).toBe(utc('2026-11-02T09:15:00Z'));
    expect(nextOccurrence(rule, anchor, utc('2026-11-02T09:15:00Z'))).toBe(utc('2026-11-04T09:15:00Z'));
    expect(nextOccurrence(rule, anchor, utc('2026-11-06T10:00:00Z'))).toBe(utc('2026-11-09T09:15:00Z'));
  });

  it('FREQ=MONTHLY on the anchor day, and HOURLY / YEARLY', () => {
    const anchor = utc('2026-11-15T12:00:00Z');
    expect(nextOccurrence('FREQ=MONTHLY', anchor, anchor)).toBe(utc('2026-12-15T12:00:00Z'));
    expect(nextOccurrence('FREQ=HOURLY;INTERVAL=2', anchor, anchor)).toBe(utc('2026-11-15T14:00:00Z'));
    expect(nextOccurrence('FREQ=YEARLY', anchor, anchor)).toBe(utc('2027-11-15T12:00:00Z'));
  });

  it('skips every occurrence missed while overdue (one firing, next in the future)', () => {
    const anchor = utc('2026-11-02T09:00:00Z');
    expect(nextOccurrence('FREQ=DAILY', anchor, utc('2026-11-10T13:00:00Z'))).toBe(utc('2026-11-11T09:00:00Z'));
  });

  it('accepts an RRULE: prefix and ignores a DTSTART line (with or without TZID)', () => {
    const anchor = utc('2026-11-02T09:00:00Z');
    expect(nextOccurrence('DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY', anchor, anchor)).toBe(
      utc('2026-11-03T09:00:00Z'),
    );
    expect(nextOccurrence('DTSTART;TZID=Europe/Paris:20200101T000000\nRRULE:FREQ=DAILY', anchor, anchor)).toBe(
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

describe('nextOccurrence in America/Los_Angeles (DST ends 2026-11-01 02:00 PDT → 01:00 PST)', () => {
  it('weekday 09:00 stays 09:00 local across the change', () => {
    const anchor = utc('2026-10-30T16:00:00Z'); // Fri 09:00 PDT
    const rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0';
    expect(nextOccurrence(rule, anchor, anchor, LA)).toBe(utc('2026-11-02T17:00:00Z')); // Mon 09:00 PST
    const s = series(rule, anchor, 6, LA);
    expect(s.map(laWall)).toEqual(['Mon 09:00', 'Tue 09:00', 'Wed 09:00', 'Thu 09:00', 'Fri 09:00', 'Mon 09:00']);
  });

  it('a plain FREQ=DAILY anchored at 09:00 local stays at 09:00 local', () => {
    const anchor = utc('2026-10-31T16:00:00Z'); // Sat 09:00 PDT
    expect(nextOccurrence('FREQ=DAILY', anchor, anchor, LA)).toBe(utc('2026-11-01T17:00:00Z')); // Sun 09:00 PST
  });

  it('BYHOUR=9 is 09:00 local, not 09:00 UTC', () => {
    const anchor = utc('2026-10-31T16:00:00Z'); // Sat 09:00 PDT
    const rule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0';
    expect(nextOccurrence(rule, anchor, anchor, LA)).toBe(utc('2026-11-01T17:00:00Z'));
    expect(series(rule, anchor, 3, LA).map(laWall)).toEqual(['Sun 09:00', 'Mon 09:00', 'Tue 09:00']);
    // Without tz the same rule means 09:00 UTC (01:00/02:00 in LA): the old behaviour.
    expect(nextOccurrence(rule, anchor, anchor)).toBe(utc('2026-11-01T09:00:00Z'));
  });

  it('an evening BYDAY rule stays on Mon-Fri local (UTC is already the next day)', () => {
    const anchor = utc('2026-10-31T01:30:00Z'); // Fri 18:30 PDT = Sat 01:30 UTC
    const rule = 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=18;BYMINUTE=30';
    const s = series(rule, anchor, 10, LA);
    expect(s[0]).toBe(utc('2026-11-03T02:30:00Z')); // Mon 18:30 PST
    expect(s.map(laWall)).toEqual([
      'Mon 18:30',
      'Tue 18:30',
      'Wed 18:30',
      'Thu 18:30',
      'Fri 18:30',
      'Mon 18:30',
      'Tue 18:30',
      'Wed 18:30',
      'Thu 18:30',
      'Fri 18:30',
    ]);
  });

  it('is strictly after `after` inside the repeated 01:00-02:00 hour (no hot loop)', () => {
    // Daily 01:30: on 2026-11-01 01:30 happens twice; the first (PDT) instant is used.
    const daily = utc('2026-10-31T08:30:00Z'); // Sat 01:30 PDT
    expect(nextOccurrence('FREQ=DAILY', daily, daily, LA)).toBe(utc('2026-11-01T08:30:00Z')); // 01:30 PDT
    // `after` = 01:10 PST (second pass): 01:30 local today maps back to 01:30 PDT, which is
    // before `after`, so the answer must be tomorrow, not that earlier instant.
    const afterSecondPass = utc('2026-11-01T09:10:00Z');
    expect(nextOccurrence('FREQ=DAILY', daily, afterSecondPass, LA)).toBe(utc('2026-11-02T09:30:00Z'));
    // Hourly at :30 through the change: every result is strictly later than the last.
    const hourly = utc('2026-11-01T07:30:00Z'); // 00:30 PDT
    expect(series('FREQ=HOURLY', hourly, 4, LA)).toEqual([
      utc('2026-11-01T08:30:00Z'), // 01:30 PDT
      utc('2026-11-01T10:30:00Z'), // 02:30 PST (the second 01:30 maps to the earlier instant, so it is skipped)
      utc('2026-11-01T11:30:00Z'),
      utc('2026-11-01T12:30:00Z'),
    ]);
    expect(nextOccurrence('FREQ=HOURLY', hourly, afterSecondPass, LA)).toBe(utc('2026-11-01T10:30:00Z'));
  });

  it('moves a nonexistent spring-forward time forward by the gap', () => {
    const anchor = utc('2027-03-13T10:30:00Z'); // Sat 02:30 PST
    expect(nextOccurrence('FREQ=DAILY', anchor, anchor, LA)).toBe(utc('2027-03-14T10:30:00Z')); // 03:30 PDT
    expect(nextOccurrence('FREQ=DAILY', anchor, utc('2027-03-14T10:30:00Z'), LA)).toBe(utc('2027-03-15T09:30:00Z'));
  });
});

describe('floating time helpers', () => {
  it('converts instants to LA wall time and back', () => {
    expect(zoneOffset(LA, utc('2026-10-30T16:00:00Z'))).toBe(-7 * 3_600_000);
    expect(zoneOffset(LA, utc('2026-11-02T17:00:00Z'))).toBe(-8 * 3_600_000);
    const t = utc('2026-11-02T17:00:00.250Z');
    expect(toFloating(t, LA).toISOString()).toBe('2026-11-02T09:00:00.250Z');
    expect(fromFloating(toFloating(t, LA), LA)).toBe(t);
    expect(toFloating(t, undefined).getTime()).toBe(t);
  });
});

describe('parseRuleOptions', () => {
  it('rejects garbage and a missing FREQ', () => {
    expect(() => parseRuleOptions('')).toThrow(/Invalid RRULE/);
    expect(() => parseRuleOptions('INTERVAL=2')).toThrow(/FREQ is required/);
    expect(() => parseRuleOptions('FREQ=SOMETIMES')).toThrow(/Invalid RRULE/);
  });

  it('allows only HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY and no BYSECOND', () => {
    for (const f of ['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']) {
      expect(() => parseRuleOptions(`FREQ=${f}`)).not.toThrow();
    }
    expect(() => parseRuleOptions('FREQ=MINUTELY')).toThrow('Invalid RRULE: FREQ=MINUTELY is not supported');
    expect(() => parseRuleOptions('FREQ=SECONDLY')).toThrow('Invalid RRULE: FREQ=SECONDLY is not supported');
    expect(() => parseRuleOptions('FREQ=DAILY;BYSECOND=0,30')).toThrow('Invalid RRULE: BYSECOND is not supported');
  });

  it('requires positive integer INTERVAL and COUNT', () => {
    expect(() => parseRuleOptions('FREQ=DAILY;INTERVAL=0')).toThrow(/INTERVAL must be a positive integer/);
    expect(() => parseRuleOptions('FREQ=DAILY;COUNT=0')).toThrow(/COUNT must be a positive integer/);
  });
});
