/**
 * "I count as away after N min": edited in whole minutes, stored
 * in seconds (`awayThresholdS`). 0 means always ping.
 */
export const AWAY_MAX_MINUTES = 24 * 60;

/** What the user typed → seconds, or `undefined` if it isn't whole minutes from 0 to a day. */
export function parseAwayMinutes(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const minutes = Number(trimmed);
  return minutes <= AWAY_MAX_MINUTES ? minutes * 60 : undefined;
}

/** Seconds → the minutes shown in the box. */
export function awayMinutes(seconds: number): string {
  return String(Math.round(seconds / 60));
}
