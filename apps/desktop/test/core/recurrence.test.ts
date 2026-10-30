import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nextOccurrence, normalizeRrule } from '../../src/main/core/recurrence';

const { RRule } = createRequire(import.meta.url)('rrule') as typeof import('rrule');

describe('recurrence', () => {
  // In UTC, floating time == real time, so plain rrule is a reference implementation.
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'UTC';
  });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  const reference = (rule: string, startAt: number, after: number, inclusive = false): number | undefined =>
    new RRule({ ...RRule.parseString(rule), dtstart: new Date(startAt) }).after(new Date(after), inclusive)?.getTime();

  const anchor = Date.parse('2025-02-14T07:20:00Z'); // ~1.7 years before `now`
  const now = Date.parse('2026-10-30T16:05:00Z');

  it.each([
    'FREQ=HOURLY',
    'FREQ=HOURLY;INTERVAL=7;BYMINUTE=15,45',
    'FREQ=DAILY',
    'FREQ=DAILY;INTERVAL=3;BYDAY=MO,TU',
    'FREQ=DAILY;BYHOUR=9,17;BYMINUTE=0',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
    'FREQ=WEEKLY;BYDAY=MO,WE;WKST=SU;INTERVAL=3',
    'FREQ=MONTHLY;BYDAY=-1FR',
    'FREQ=YEARLY',
    'FREQ=DAILY;UNTIL=20261105T000000Z',
    'FREQ=DAILY;COUNT=1000',
  ])('fast-forwarding an old anchor gives the same next occurrence as plain rrule: %s', (rule) => {
    for (const after of [now, now + 3_600_000, now + 86_400_000 * 9]) {
      expect(nextOccurrence(rule, anchor, after)).toBe(reference(rule, anchor, after));
      expect(nextOccurrence(rule, anchor, after, true)).toBe(reference(rule, anchor, after, true));
    }
  });

  it('is fast for an hourly rule anchored ten years back', () => {
    const tenYearsAgo = now - 10 * 365 * 86_400_000;
    const started = performance.now();
    for (let i = 0; i < 10; i++) nextOccurrence('FREQ=HOURLY;BYMINUTE=0,15,30,45', tenYearsAgo, now);
    // Without fast-forward one call takes ~0.5 s; with it, microseconds. Generous bound to avoid flakiness.
    expect(performance.now() - started).toBeLessThan(1000);
    expect(nextOccurrence('FREQ=HOURLY;BYMINUTE=0,15,30,45', tenYearsAgo, now)).toBe(Date.parse('2026-10-30T16:15:00Z'));
  });

  it('normalizes rules', () => {
    expect(normalizeRrule('RRULE:FREQ=WEEKLY;BYDAY=MO')).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(normalizeRrule('DTSTART:20200101T000000Z\nRRULE:FREQ=DAILY')).toBe('FREQ=DAILY');
  });
});
