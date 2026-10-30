/** Snooze choices on a note card, and when each one wakes the note up again. */

export type SnoozeChoice = '10m' | '1h' | 'tomorrow';

export const SNOOZE_CHOICES: readonly { choice: SnoozeChoice; label: string }[] = [
  { choice: '10m', label: '10 min' },
  { choice: '1h', label: '1 hour' },
  { choice: 'tomorrow', label: 'Tomorrow 9:00' },
];

/** Epoch ms when a note snoozed at `now` with `choice` comes back. "Tomorrow" is 09:00 local time on the next calendar day. */
export function snoozeUntil(choice: SnoozeChoice, now: number): number {
  switch (choice) {
    case '10m':
      return now + 10 * 60_000;
    case '1h':
      return now + 60 * 60_000;
    case 'tomorrow': {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
      return d.getTime();
    }
  }
}
