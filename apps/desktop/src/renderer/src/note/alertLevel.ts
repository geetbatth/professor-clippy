import type { Message } from '@clippy/shared/schemas';
import type { Settings } from '@clippy/shared/settings';

/**
 * How loudly a new message announces itself. Loud = ding, quip, wiggle and the note pops open;
 * quiet = only the unread badge and the stack. Questions, reminders, urgent notes (permission
 * requests) and Clippy's own notes (nudges, the morning brief) are loud; a plain agent note
 * (say "agent finished") is quiet unless the user chose to be popped up for everything.
 */
export function alertLevel(m: Message, popUpFor: Settings['popUpFor']): 'loud' | 'quiet' {
  if (popUpFor === 'everything') return 'loud';
  if (m.kind === 'ask' || m.kind === 'reminder' || m.urgent || m.sender === 'clippy') return 'loud';
  return 'quiet';
}

/**
 * How many of `messages` are loud. This (not the badge total) drives Clippy's nagging and
 * waking, so a quiet note never earns a tap on the glass or a boing.
 */
export function loudCount(messages: readonly Message[], popUpFor: Settings['popUpFor']): number {
  return messages.filter((m) => alertLevel(m, popUpFor) === 'loud').length;
}
