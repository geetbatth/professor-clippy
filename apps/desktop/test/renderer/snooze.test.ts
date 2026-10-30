import { describe, expect, it } from 'vitest';
import { snoozeUntil } from '../../src/renderer/src/note/snooze';
import { timeAgo } from '../../src/renderer/src/note/timeAgo';

describe('snoozeUntil', () => {
  const now = new Date(2026, 9, 30, 15, 42, 17, 500).getTime();

  it('adds 10 minutes', () => {
    expect(snoozeUntil('10m', now)).toBe(now + 10 * 60_000);
  });

  it('adds an hour', () => {
    expect(snoozeUntil('1h', now)).toBe(now + 60 * 60_000);
  });

  it('tomorrow is 09:00:00.000 local time on the next day', () => {
    expect(new Date(snoozeUntil('tomorrow', now))).toEqual(new Date(2026, 9, 31, 9, 0, 0, 0));
  });

  it('tomorrow from just after midnight is still the next calendar day', () => {
    const early = new Date(2026, 9, 30, 0, 5).getTime();
    expect(new Date(snoozeUntil('tomorrow', early))).toEqual(new Date(2026, 9, 31, 9, 0));
  });

  it('rolls over month and year ends', () => {
    expect(new Date(snoozeUntil('tomorrow', new Date(2026, 11, 31, 20, 0).getTime()))).toEqual(new Date(2027, 0, 1, 9, 0));
  });
});

describe('timeAgo', () => {
  const now = new Date(2026, 9, 30, 15, 0).getTime();
  it('formats recent times', () => {
    expect(timeAgo(now - 20_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
  });
  it('names yesterday', () => {
    expect(timeAgo(new Date(2026, 9, 29, 9, 30).getTime(), now)).toMatch(/^yesterday /);
  });
  it('never goes negative for clock skew', () => {
    expect(timeAgo(now + 60_000, now)).toBe('just now');
  });
});
