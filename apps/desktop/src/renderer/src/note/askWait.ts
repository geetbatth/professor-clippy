/** The "wait for answers" setting is edited in whole minutes and stored in seconds. */
export const ASK_WAIT_MIN_MINUTES = 1;
export const ASK_WAIT_MAX_MINUTES = 24 * 60;

/** Parse what the user typed into seconds, or `undefined` if it isn't a whole number of minutes in range. */
export function parseAskWait(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const minutes = Number(trimmed);
  if (minutes < ASK_WAIT_MIN_MINUTES || minutes > ASK_WAIT_MAX_MINUTES) return undefined;
  return minutes * 60;
}

/** Seconds → the minutes shown in the box. */
export function askWaitMinutes(seconds: number): string {
  return String(Math.max(1, Math.round(seconds / 60)));
}
