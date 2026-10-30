import { describe, expect, it } from 'vitest';
import type { Message } from '@clippy/shared/schemas';
import { applyToStack, buildStack, isArrival } from '../../src/renderer/src/note/unreadStack';

let n = 0;
function msg(p: Partial<Message>): Message {
  n += 1;
  return { id: `01JB${String(n).padStart(22, '0')}`, kind: 'note', body: `m${n}`, sender: 'a', urgent: false, state: 'unread', createdAt: n * 1000, ...p };
}

describe('unread stack', () => {
  it('keeps unread notes, reminders and asks, newest first, and drops chat and handled ones', () => {
    const a = msg({ createdAt: 1 });
    const b = msg({ kind: 'reminder', createdAt: 3 });
    const c = msg({ kind: 'ask', createdAt: 2 });
    const chat = msg({ kind: 'chat', createdAt: 9 });
    const done = msg({ state: 'done', createdAt: 8 });
    const snoozed = msg({ state: 'snoozed', createdAt: 7 });
    expect(buildStack([a, b, c, chat, done, snoozed]).map((m) => m.id)).toEqual([b.id, c.id, a.id]);
  });

  it('inserts new messages in order and replaces updated ones in place', () => {
    const old = msg({ createdAt: 10 });
    const newer = msg({ createdAt: 20 });
    let stack = applyToStack([], old);
    stack = applyToStack(stack, newer);
    expect(stack.map((m) => m.id)).toEqual([newer.id, old.id]);
    stack = applyToStack(stack, { ...old, body: 'edited' });
    expect(stack).toHaveLength(2);
    expect(stack[1]?.body).toBe('edited');
  });

  it('removes messages that were done or snoozed, and brings back ones that wake up', () => {
    const m = msg({});
    let stack = applyToStack([], m);
    stack = applyToStack(stack, { ...m, state: 'snoozed', snoozedUntil: 5 });
    expect(stack).toEqual([]);
    stack = applyToStack(stack, { ...m, state: 'unread' });
    expect(stack.map((x) => x.id)).toEqual([m.id]);
    expect(applyToStack(stack, { ...m, state: 'done' })).toEqual([]);
  });
  it('counts a snoozed note waking up as an arrival, but not edits or departures', () => {
    const m = msg({});
    expect(isArrival([], m)).toBe(true); // brand new
    const stack = applyToStack([], m);
    expect(isArrival(stack, { ...m, body: 'edited' })).toBe(false); // already there
    const snoozed = applyToStack(stack, { ...m, state: 'snoozed', snoozedUntil: 5 });
    expect(isArrival(snoozed, { ...m, state: 'snoozed', snoozedUntil: 5 })).toBe(false);
    expect(isArrival(snoozed, { ...m, state: 'unread', snoozedUntil: 5 })).toBe(true); // snooze over
    expect(isArrival(stack, { ...m, state: 'done' })).toBe(false);
    expect(isArrival([], msg({ kind: 'chat' }))).toBe(false);
  });
});
