import { describe, expect, it } from 'vitest';
import {
  ADVICE_MAX_MS,
  ADVICE_MIN_MS,
  nextAdviceDelay,
  pickQuip,
  QUIPS,
  quipTagFor,
  type QuipTag,
} from '../../src/renderer/src/quips/pickQuip';

const noon = new Date(2026, 9, 30, 12, 0);
const lateNight = new Date(2026, 9, 30, 23, 30);
const note = (body: string, title?: string) => ({ kind: 'note' as const, body, title });

describe('quips.json', () => {
  const tags: QuipTag[] = ['build', 'error', 'reminder', 'ask', 'lateNight', 'generic', 'advice'];

  it('has at least 60 unique one-liners across all seven tags', () => {
    const all = tags.flatMap((t) => QUIPS[t]);
    expect(all.length).toBeGreaterThanOrEqual(60);
    expect(new Set(all).size).toBe(all.length);
    for (const t of tags) expect(QUIPS[t].length, t).toBeGreaterThanOrEqual(5);
  });

  it('keeps quips to one short line', () => {
    for (const q of Object.values(QUIPS).flat()) {
      expect(q).not.toContain('\n');
      expect(q.length).toBeLessThanOrEqual(100);
    }
  });
});

describe('quipTagFor', () => {
  it('uses the kind for reminders and asks', () => {
    expect(quipTagFor({ kind: 'reminder', body: 'Build failed' }, noon)).toBe('reminder');
    expect(quipTagFor({ kind: 'ask', body: 'Deploy?' }, noon)).toBe('ask');
  });

  it('spots errors', () => {
    expect(quipTagFor(note('Tests failed on the payments service'), noon)).toBe('error');
    expect(quipTagFor(note('Unhandled exception in worker.ts'), noon)).toBe('error');
    expect(quipTagFor(note('details', 'Crash on startup'), noon)).toBe('error');
  });

  it('treats "0 failed" / "no errors" as good news', () => {
    expect(quipTagFor(note('214 tests passed, 0 failed. Deployed to staging.'), noon)).toBe('build');
    expect(quipTagFor(note('Compiled with no errors'), noon)).toBe('build');
  });

  it('spots builds and finished work', () => {
    expect(quipTagFor(note('Build finished in 3m'), noon)).toBe('build');
    expect(quipTagFor(note('PR merged into main'), noon)).toBe('build');
  });

  it('falls back to lateNight in the small hours, else generic', () => {
    expect(quipTagFor(note('Here is the summary you wanted'), lateNight)).toBe('lateNight');
    expect(quipTagFor(note('Here is the summary you wanted'), new Date(2026, 9, 30, 4, 59))).toBe('lateNight');
    expect(quipTagFor(note('Here is the summary you wanted'), noon)).toBe('generic');
  });

  it('errors beat late night', () => {
    expect(quipTagFor(note('Deploy failed'), lateNight)).toBe('error');
  });
});

describe('pickQuip', () => {
  it('picks from the requested tag using the rng', () => {
    expect(pickQuip('error', () => 0)).toBe(QUIPS.error[0]);
    expect(pickQuip('error', () => 0.9999)).toBe(QUIPS.error.at(-1));
  });

  it('avoids repeating the last quip', () => {
    const first = QUIPS.build[0]!;
    expect(pickQuip('build', () => 0, first)).toBe(QUIPS.build[1]);
  });

  it('still returns something when the only quip is the one to avoid', () => {
    const book = { ...QUIPS, advice: ['Only one'] };
    expect(pickQuip('advice', () => 0.5, 'Only one', book)).toBe('Only one');
  });

  it('falls back to generic for an empty tag', () => {
    const book = { ...QUIPS, ask: [] };
    expect(QUIPS.generic).toContain(pickQuip('ask', () => 0.3, undefined, book));
  });
});

describe('nextAdviceDelay', () => {
  it('is between 30 and 90 minutes', () => {
    expect(nextAdviceDelay(() => 0)).toBe(ADVICE_MIN_MS);
    expect(nextAdviceDelay(() => 0.999999)).toBeLessThan(ADVICE_MAX_MS);
    expect(nextAdviceDelay(() => 0.5)).toBe(60 * 60_000);
  });
});
