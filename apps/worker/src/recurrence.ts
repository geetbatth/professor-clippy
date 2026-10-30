/**
 * RRULE handling via the `rrule` package (pure JS, bundles for Workers).
 *
 * Semantics (same as `rrule`'s defaults, which the desktop scheduler also uses):
 * - DTSTART is the reminder's anchor: the `dueAt` it was last PUT with. A `DTSTART`
 *   inside the string is ignored, so COUNT counts from that anchor.
 * - Times are UTC. BYHOUR/BYMINUTE are UTC hours/minutes; without them the
 *   time of day comes from the anchor. Time zones (TZID) are not supported.
 */
import { RRule } from 'rrule';

/** Parse an RRULE string (`FREQ=...` or `RRULE:FREQ=...`) anchored at `dtstart`; throws if invalid. */
export function parseRule(rrule: string, dtstart: number): RRule {
  const line = rrule
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !/^DTSTART[:;]/i.test(l));
  if (!line) throw new Error('Invalid RRULE: empty');
  let options: ReturnType<typeof RRule.parseString>;
  try {
    options = RRule.parseString(line);
  } catch (err) {
    throw new Error(`Invalid RRULE: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (options.freq === undefined || options.freq === null) throw new Error('Invalid RRULE: FREQ is required');
  return new RRule({ ...options, dtstart: new Date(dtstart) });
}

/** First occurrence strictly after `after` (epoch ms), or undefined when the rule is exhausted. */
export function nextOccurrence(rrule: string, dtstart: number, after: number): number | undefined {
  const next = parseRule(rrule, dtstart).after(new Date(after), false);
  return next ? next.getTime() : undefined;
}
