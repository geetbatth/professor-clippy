import { describe, expect, it } from 'vitest';
import { askWaitMinutes, parseAskWait } from '../../src/renderer/src/note/askWait';

describe('ask wait input', () => {
  it('accepts whole minutes from 1 to 1440 and returns seconds', () => {
    expect(parseAskWait('10')).toBe(600);
    expect(parseAskWait(' 1 ')).toBe(60);
    expect(parseAskWait('1440')).toBe(86_400);
  });
  it('rejects empty, zero, negative, fractional, huge and non-numeric input', () => {
    for (const bad of ['', '0', '-5', '2.5', '1441', 'ten', '1e3']) expect(parseAskWait(bad), bad).toBeUndefined();
  });
  it('shows stored seconds as minutes', () => {
    expect(askWaitMinutes(600)).toBe('10');
    expect(askWaitMinutes(90)).toBe('2');
    expect(askWaitMinutes(10)).toBe('1');
  });
});
