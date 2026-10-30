/**
 * RRULE handling via the `rrule` package (pure JS, bundles for Workers).
 *
 * Semantics (same as the desktop scheduler, apps/desktop core recurrence):
 * - DTSTART is the reminder's anchor: the `startAt` it was last PUT with (the PC's original
 *   start), else that PUT's `dueAt`. A `DTSTART` (and any TZID) inside the string is
 *   ignored, so COUNT counts from that anchor, as on the desktop.
 * - The rule runs on FLOATING wall time in the reminder's IANA zone `tz` (UTC when
 *   absent): `dueAt` is converted to its local wall time, `rrule` iterates on that
 *   (dressed as UTC), and each result is converted back to an instant. So
 *   "BYHOUR=9" is 09:00 local and stays 09:00 across DST.
 * - Wall times that don't exist (spring-forward gap) move forward by the gap and
 *   ambiguous ones (fall-back) take the earlier instant, like JS `new Date(y, m, d, h)`.
 * - The next occurrence is always strictly after `after`, even in the repeated
 *   fall-back hour.
 * - Allowed FREQ: HOURLY, DAILY, WEEKLY, MONTHLY, YEARLY. SECONDLY, MINUTELY and
 *   BYSECOND are rejected (a reminder relay is not a timer).
 */
import { Frequency, RRule, type Options } from 'rrule';

const ALLOWED_FREQ = new Set<Frequency>([
  Frequency.HOURLY,
  Frequency.DAILY,
  Frequency.WEEKLY,
  Frequency.MONTHLY,
  Frequency.YEARLY,
]);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Bound on candidates skipped while looking past an ambiguous/gap wall time. */
const MAX_SKIPS = 1000;

/**
 * Validate an RRULE string (`FREQ=...` or `RRULE:FREQ=...`, optionally after a
 * DTSTART line) and return its options without DTSTART/TZID. Throws `Invalid RRULE: ...`.
 */
export function parseRuleOptions(rrule: string): Partial<Options> {
  const line = rrule
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^DTSTART[:;]/i.test(l));
  if (!line) throw new Error('Invalid RRULE: empty');
  let options: Partial<Options>;
  try {
    options = RRule.parseString(line);
  } catch (err) {
    throw new Error(`Invalid RRULE: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (options.freq === undefined || options.freq === null) throw new Error('Invalid RRULE: FREQ is required');
  if (!ALLOWED_FREQ.has(options.freq)) {
    throw new Error(`Invalid RRULE: FREQ=${Frequency[options.freq]} is not supported`);
  }
  if (options.bysecond !== undefined && options.bysecond !== null) {
    throw new Error('Invalid RRULE: BYSECOND is not supported');
  }
  for (const key of ['interval', 'count'] as const) {
    const value = options[key];
    if (value !== undefined && value !== null && !(Number.isInteger(value) && value > 0)) {
      throw new Error(`Invalid RRULE: ${key.toUpperCase()} must be a positive integer`);
    }
  }
  const { dtstart: _dtstart, tzid: _tzid, ...rest } = options;
  return rest;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(tz, f);
  }
  return f;
}

/** UTC offset of `tz` at instant `t` (wall time minus instant), in ms. */
export function zoneOffset(tz: string, t: number): number {
  const parts: Record<string, number> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) parts[p.type] = Number(p.value);
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  const wholeSeconds = t - (((t % 1000) + 1000) % 1000);
  return wall - wholeSeconds;
}

/** Wall time of instant `t` in `tz`, dressed as a UTC Date (rrule "floating" time). */
export function toFloating(t: number, tz: string | undefined): Date {
  return new Date(tz ? t + zoneOffset(tz, t) : t);
}

/** Instant of floating wall time `d` in `tz`: gap → shifted forward, ambiguous → earlier. */
export function fromFloating(d: Date, tz: string | undefined): number {
  const wall = d.getTime();
  if (!tz) return wall;
  const before = zoneOffset(tz, wall - DAY_MS);
  const after = zoneOffset(tz, wall + DAY_MS);
  const valid = [wall - before, wall - after].filter((t) => zoneOffset(tz, t) === wall - t);
  if (valid.length > 0) return Math.min(...valid);
  return wall - before; // nonexistent wall time: use the pre-transition offset, like JS Date
}

/**
 * First occurrence strictly after `after` (epoch ms) of `rrule` anchored at
 * `dtstart`, evaluated in `tz` (UTC if undefined), or undefined when exhausted.
 */
export function nextOccurrence(rrule: string, dtstart: number, after: number, tz?: string): number | undefined {
  const rule = new RRule({ ...parseRuleOptions(rrule), dtstart: toFloating(dtstart, tz) });
  let cursor = toFloating(after, tz);
  for (let i = 0; i < MAX_SKIPS; i++) {
    const next = rule.after(cursor, false);
    if (!next) return undefined;
    const instant = fromFloating(next, tz);
    if (instant > after) return instant;
    cursor = next; // wall time maps to an instant not after `after` (fall-back hour): keep going
  }
  return undefined;
}
