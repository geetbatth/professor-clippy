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
 * First occurrence of `rrule` (anchored at `startAt`) after `after`, or at it when
 * `inclusive`. Epoch ms, or undefined when the rule has no more occurrences.
 */
export function nextOccurrence(rrule: string, startAt: number, after: number, inclusive = false): number | undefined {
  const rule = new RRule({ ...parseRrule(rrule), dtstart: toFloating(startAt) });
  const next = rule.after(toFloating(after), inclusive);
  return next ? fromFloating(next) : undefined;
}

function parseRrule(rrule: string): Partial<Options> {
  let options: Partial<Options>;
  try {
    options = RRule.parseString(rrule.trim());
  } catch (err) {
    throw new ValidationError(`Invalid rrule: ${(err as Error).message}`);
  }
  if (options.freq === undefined || options.freq === null) throw new ValidationError('Invalid rrule: FREQ is required');
  if (options.freq === Frequency.SECONDLY) throw new ValidationError('Invalid rrule: FREQ=SECONDLY is not supported');
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
