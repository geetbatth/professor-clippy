/** The sticky note's unread stack: agent notes, reminders and asks (not chat), newest first. Pure. */
import type { Message } from '@clippy/shared/schemas';

export function belongsOnStack(m: Message): boolean {
  return m.state === 'unread' && m.kind !== 'chat';
}

const newestFirst = (a: Message, b: Message) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1);

export function buildStack(messages: readonly Message[]): Message[] {
  return messages.filter(belongsOnStack).sort(newestFirst);
}

/** Apply a `message:new` / `message:updated` payload: insert, replace, or drop it from the stack. */
export function applyToStack(stack: readonly Message[], m: Message): Message[] {
  const rest = stack.filter((x) => x.id !== m.id);
  return belongsOnStack(m) ? [...rest, m].sort(newestFirst) : rest;
}
