import { describe, expect, it } from 'vitest';
import { AWAY_MAX_MINUTES, awayMinutes, parseAwayMinutes } from '../../src/renderer/src/note/awayThreshold';

describe('away threshold field', () => {
  it('takes whole minutes from 0 (always ping) to a day, stored in seconds', () => {
    expect(parseAwayMinutes(' 3 ')).toBe(180);
    expect(parseAwayMinutes('0')).toBe(0);
    expect(parseAwayMinutes(String(AWAY_MAX_MINUTES))).toBe(AWAY_MAX_MINUTES * 60);
    expect(parseAwayMinutes(String(AWAY_MAX_MINUTES + 1))).toBeUndefined();
    expect(parseAwayMinutes('1.5')).toBeUndefined();
    expect(parseAwayMinutes('-1')).toBeUndefined();
    expect(parseAwayMinutes('')).toBeUndefined();
    expect(awayMinutes(180)).toBe('3');
    expect(awayMinutes(0)).toBe('0');
  });
});
