/**
 * RRULE handling for recurring reminders (via `rrule`).
 *
 * Recurrences are computed in the PC's **local wall-clock time**: "every day at
 * 09:00" stays at 09:00 local across DST changes. `rrule` works in UTC, so we
 * use its documented "floating time" approach: feed it local wall-clock fields
 * dressed as UTC, then read the results back as local time.
 */
import { createRequire } from 'node:module';
import type { Options } from 'rrule';
import { ValidationError } from './errors';

// rrule ships CommonJS without ESM named exports, so `import { RRule } from 'rrule'`
// fails at runtime under Node/Electron ESM (the main bundle externalizes it). require() works everywhere.
const { RRule, Frequency } = createRequire(import.meta.url)('rrule') as typeof import('rrule');

/**
 * Validate an RRULE string (with or without the `RRULE:` prefix) and return its
 * canonical form without the prefix, e.g. `FREQ=WEEKLY;BYDAY=MO`. Any DTSTART is
 * ignored: the reminder's `when` is the recurrence start. Throws ValidationError.
 */
export function normalizeRrule(rrule: string): string {
  const options = parseRrule(rrule);
  return new RRule(options).toString().replace(/^RRULE:/, '');
}

/**
 * First occurrence of `rrule` (anchored at `startAt`) strictly after `after`, or
 * at/after it when `inclusive`. Epoch ms, or undefined when the rule has no more
 * occurrences.
 *
 * The result is guaranteed to be > `after` (>= when inclusive) as a real instant.
 * That isn't automatic: when the clocks fall back, a floating occurrence in the
 * repeated hour maps to the *first* pass of that hour, which can lie before
 * `after` during the second pass. Such occurrences are skipped (they already
 * happened, on the first pass).
 */
export function nextOccurrence(rrule: string, startAt: number, after: number, inclusive = false): number | undefined {
  const options = parseRrule(rrule);
  const target = toFloating(after);
  const rule = new RRule({ ...options, dtstart: new Date(fastForward(options, toFloating(startAt).getTime(), target.getTime())) });
  let cursor = target;
  let inc = inclusive;
  for (let i = 0; i < 100; i++) {
    const next = rule.after(cursor, inc);
    if (!next) return undefined;
    const at = fromFloating(next);
    if (inclusive ? at >= after : at > after) return at;
    cursor = next;
    inc = false;
  }
  return undefined;
}

/** Allowed FREQ values (controller ruling, shared with the Worker). */
const ALLOWED_FREQS = new Set<number>([Frequency.HOURLY, Frequency.DAILY, Frequency.WEEKLY, Frequency.MONTHLY, Frequency.YEARLY]);

/** Fixed period of each FREQ in floating time (no DST there), for fast-forwarding. */
const PERIOD_MS = new Map<number, number>([
  [Frequency.HOURLY, 3_600_000],
  [Frequency.DAILY, 86_400_000],
  [Frequency.WEEKLY, 7 * 86_400_000],
]);

/**
 * rrule iterates from DTSTART, so an old anchor makes every lookup slow (an
 * hourly rule anchored 10 years back costs ~0.3 s). Without COUNT, moving the
 * anchor forward by whole INTERVAL periods gives exactly the same future
 * occurrences (period alignment and the defaults rrule derives from DTSTART,
 * like time of day and weekday, are unchanged), so jump to within a period or
 * two of `target`. MONTHLY/YEARLY rules have few iterations anyway.
 */
function fastForward(options: Partial<Options>, anchor: number, target: number): number {
  const base = PERIOD_MS.get(options.freq!);
  if (base === undefined || options.count != null) return anchor;
  const period = base * (options.interval ?? 1);
  const periods = Math.floor((target - anchor) / period) - 1;
  return periods > 0 ? anchor + periods * period : anchor;
}

function parseRrule(rrule: string): Partial<Options> {
  let options: Partial<Options>;
  try {
    options = RRule.parseString(rrule.trim());
  } catch (err) {
    throw new ValidationError(`Invalid rrule: ${(err as Error).message}`);
  }
  if (options.freq === undefined || options.freq === null) throw new ValidationError('Invalid rrule: FREQ is required');
  if (!ALLOWED_FREQS.has(options.freq)) {
    throw new ValidationError(`Invalid rrule: FREQ=${Frequency[options.freq]} is not supported (use HOURLY, DAILY, WEEKLY, MONTHLY or YEARLY)`);
  }
  if (options.bysecond != null) throw new ValidationError('Invalid rrule: BYSECOND is not supported');
  for (const key of ['interval', 'count'] as const) {
    const value = options[key];
    if (value !== undefined && value !== null && !(Number.isInteger(value) && value > 0)) {
      throw new ValidationError(`Invalid rrule: ${key.toUpperCase()} must be a positive integer`);
    }
  }
  const { dtstart: _dtstart, tzid: _tzid, ...rest } = options;
  return rest;
}

/** Local wall-clock time of `ms`, expressed as a UTC Date (rrule "floating" time). */
function toFloating(ms: number): Date {
  const d = new Date(ms);
  return new Date(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()),
  );
}

/** Inverse of {@link toFloating}: read a floating UTC Date's fields as local time. */
function fromFloating(d: Date): number {
  return new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  ).getTime();
}
