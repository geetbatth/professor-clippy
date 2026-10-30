import { describe, expect, it } from 'vitest';
import {
  BIG_JUMP_MS,
  initialMoodState,
  MOOD_TIMING,
  moodReducer,
  moodView,
  TRANSIENT_MS,
  type MoodEvent,
  type MoodState,
} from '../../src/renderer/src/clippy/mood';

const MIN = 60_000;
const T0 = 1_000_000;

function run(events: MoodEvent[], state: MoodState = initialMoodState(T0)): MoodState {
  return events.reduce(moodReducer, state);
}
const view = (s: MoodState) => moodView(s);

describe('moodReducer', () => {
  it('starts idle and stays idle before the sleep timeout', () => {
    const s = run([{ type: 'tick', now: T0 + MOOD_TIMING.sleepAfterMs - 1 }]);
    expect(view(s).mood).toBe('idle');
  });

  it('falls asleep after 10 idle minutes with nothing unread', () => {
    const s = run([{ type: 'tick', now: T0 + 10 * MIN }]);
    expect(view(s).mood).toBe('sleep');
  });

  it('activity resets the sleep timer', () => {
    const s = run([
      { type: 'activity', now: T0 + 9 * MIN },
      { type: 'tick', now: T0 + 10 * MIN },
    ]);
    expect(view(s).mood).toBe('idle');
  });

  it('wakes on activity: wake plays, then back to idle', () => {
    const asleep = run([{ type: 'tick', now: T0 + 10 * MIN }]);
    const woken = moodReducer(asleep, { type: 'activity', now: T0 + 11 * MIN });
    expect(view(woken).mood).toBe('wake');
    const after = moodReducer(woken, { type: 'tick', now: T0 + 11 * MIN + TRANSIENT_MS.wake });
    expect(view(after).mood).toBe('idle');
  });

  it('a new message while asleep plays wake then jump', () => {
    const asleep = run([{ type: 'tick', now: T0 + 10 * MIN }]);
    const t = T0 + 20 * MIN;
    let s = moodReducer(asleep, { type: 'message', now: t, urgent: false });
    expect(view(s)).toMatchObject({ mood: 'wake', big: false });
    s = moodReducer(s, { type: 'tick', now: t + TRANSIENT_MS.wake });
    expect(view(s)).toMatchObject({ mood: 'jump', big: false });
    s = moodReducer(s, { type: 'tick', now: t + TRANSIENT_MS.wake + TRANSIENT_MS.jump });
    expect(view(s).mood).toBe('idle');
  });

  it('an urgent message gets the big antics immediately', () => {
    const s = run([{ type: 'message', now: T0, urgent: true }]);
    expect(view(s)).toMatchObject({ mood: 'jump', big: true });
    const later = moodReducer(s, { type: 'tick', now: T0 + TRANSIENT_MS.jump });
    expect(view(later).mood).toBe('jump'); // the big jump lasts longer
    expect(view(moodReducer(s, { type: 'tick', now: T0 + BIG_JUMP_MS })).mood).toBe('idle');
  });

  it('taps on the glass after 2 minutes of ignored unread notes, then every 2 minutes', () => {
    let s = run([{ type: 'unread', now: T0, count: 2 }]);
    s = moodReducer(s, { type: 'tick', now: T0 + 2 * MIN - 1 });
    expect(view(s).mood).toBe('idle');
    s = moodReducer(s, { type: 'tick', now: T0 + 2 * MIN });
    expect(view(s).mood).toBe('tapGlass');
    s = moodReducer(s, { type: 'tick', now: T0 + 3 * MIN });
    expect(view(s).mood).toBe('idle');
    s = moodReducer(s, { type: 'tick', now: T0 + 4 * MIN });
    expect(view(s).mood).toBe('tapGlass');
  });

  it('escalates to the big jump after 10 ignored minutes', () => {
    let s = run([{ type: 'unread', now: T0, count: 1 }]);
    for (let m = 1; m < 10; m++) s = moodReducer(s, { type: 'tick', now: T0 + m * MIN });
    s = moodReducer(s, { type: 'tick', now: T0 + 10 * MIN });
    expect(view(s)).toMatchObject({ mood: 'jump', big: true });
    // Not again until another 10 minutes have passed (taps in between).
    s = moodReducer(s, { type: 'tick', now: T0 + 12 * MIN });
    expect(view(s)).toMatchObject({ mood: 'tapGlass', big: false });
  });

  it('activity resets the ignore clock', () => {
    let s = run([{ type: 'unread', now: T0, count: 1 }]);
    s = moodReducer(s, { type: 'activity', now: T0 + 90_000 });
    s = moodReducer(s, { type: 'tick', now: T0 + 2 * MIN });
    expect(view(s).mood).toBe('idle');
    s = moodReducer(s, { type: 'tick', now: T0 + 90_000 + 2 * MIN });
    expect(view(s).mood).toBe('tapGlass');
  });

  it('does not fall asleep while notes are unread', () => {
    let s = run([{ type: 'unread', now: T0, count: 1 }]);
    s = moodReducer(s, { type: 'tick', now: T0 + 30 * MIN });
    expect(s.asleep).toBe(false);
  });

  it('celebrates when the unread stack empties, but not on an empty start', () => {
    expect(view(run([{ type: 'unread', now: T0, count: 0 }])).mood).toBe('idle');
    const s = run([
      { type: 'unread', now: T0, count: 3 },
      { type: 'unread', now: T0 + 1000, count: 1 },
      { type: 'unread', now: T0 + 2000, count: 0 },
    ]);
    expect(view(s).mood).toBe('celebrate');
    expect(view(moodReducer(s, { type: 'tick', now: T0 + 2000 + TRANSIENT_MS.celebrate })).mood).toBe('idle');
  });

  it('thinks while the brain is thinking, and stops nagging meanwhile', () => {
    let s = run([
      { type: 'unread', now: T0, count: 1 },
      { type: 'thinking', now: T0, thinking: true },
    ]);
    expect(view(s).mood).toBe('think');
    s = moodReducer(s, { type: 'tick', now: T0 + 5 * MIN });
    expect(view(s).mood).toBe('think');
    s = moodReducer(s, { type: 'thinking', now: T0 + 5 * MIN, thinking: false });
    expect(view(s).mood).toBe('idle');
  });

  it('thinking wakes a sleeping Clippy', () => {
    const asleep = run([{ type: 'tick', now: T0 + 10 * MIN }]);
    const s = moodReducer(asleep, { type: 'thinking', now: T0 + 11 * MIN, thinking: true });
    expect(view(s).mood).toBe('wake');
    expect(view(moodReducer(s, { type: 'tick', now: T0 + 11 * MIN + TRANSIENT_MS.wake })).mood).toBe('think');
  });

  it('reads while expanded with unread notes', () => {
    const s = run([
      { type: 'unread', now: T0, count: 1 },
      { type: 'expanded', now: T0, expanded: true },
    ]);
    expect(view(s).mood).toBe('read');
    expect(view(moodReducer(s, { type: 'unread', now: T0, count: 0 })).mood).toBe('celebrate');
  });

  it('blinks only from idle and never interrupts another transient', () => {
    const idle = run([{ type: 'blink', now: T0 }]);
    expect(view(idle).mood).toBe('blink');
    expect(view(moodReducer(idle, { type: 'tick', now: T0 + TRANSIENT_MS.blink })).mood).toBe('idle');

    const jumping = run([{ type: 'message', now: T0, urgent: false }]);
    expect(view(moodReducer(jumping, { type: 'blink', now: T0 + 10 })).mood).toBe('jump');

    const asleep = run([{ type: 'tick', now: T0 + 10 * MIN }]);
    expect(view(moodReducer(asleep, { type: 'blink', now: T0 + 10 * MIN })).mood).toBe('sleep');
  });

  it('a message replaces a blink instead of waiting for it', () => {
    const s = run([
      { type: 'blink', now: T0 },
      { type: 'message', now: T0 + 50, urgent: false },
    ]);
    expect(view(s).mood).toBe('jump');
  });

  it('bumps seq for every transient so repeats are observable', () => {
    const a = run([{ type: 'message', now: T0, urgent: false }]);
    const b = moodReducer(moodReducer(a, { type: 'tick', now: T0 + TRANSIENT_MS.jump }), {
      type: 'message',
      now: T0 + TRANSIENT_MS.jump,
      urgent: false,
    });
    expect(view(b).mood).toBe('jump');
    expect(view(b).seq).toBe(view(a).seq + 1);
  });

  it('does not queue duplicates and caps the queue', () => {
    let s = run([{ type: 'message', now: T0, urgent: false }]);
    for (let i = 0; i < 5; i++) s = moodReducer(s, { type: 'message', now: T0 + i, urgent: i % 2 === 0 });
    expect(s.queue.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < s.queue.length; i++) {
      expect(s.queue[i]).not.toEqual(s.queue[i - 1]);
    }
  });
  it('an advice jump with nothing unread does not start the ignore clock early', () => {
    let s = run([{ type: 'message', now: T0, urgent: false }]);
    s = moodReducer(s, { type: 'tick', now: T0 + 5 * MIN });
    s = moodReducer(s, { type: 'unread', now: T0 + 5 * MIN, count: 1 });
    s = moodReducer(s, { type: 'tick', now: T0 + 6 * MIN });
    expect(view(s).mood).toBe('idle');
    s = moodReducer(s, { type: 'tick', now: T0 + 7 * MIN });
    expect(view(s).mood).toBe('tapGlass');
  });
  it('blinks do not change the replay key, so resting loops are never remounted', () => {
    const idle = initialMoodState(T0);
    const blinking = moodReducer(idle, { type: 'blink', now: T0 });
    expect(view(blinking)).toMatchObject({ mood: 'blink', seq: view(idle).seq });
    const back = moodReducer(blinking, { type: 'tick', now: T0 + TRANSIENT_MS.blink });
    expect(view(back)).toMatchObject({ mood: 'idle', seq: view(idle).seq });
    // Many blinks later, still the same key.
    let s = back;
    for (let i = 1; i <= 20; i++) {
      s = moodReducer(s, { type: 'blink', now: T0 + i * 5000 });
      s = moodReducer(s, { type: 'tick', now: T0 + i * 5000 + TRANSIENT_MS.blink });
    }
    expect(view(s).seq).toBe(view(idle).seq);
  });

  it('every non-blink transient gets a new replay key, including one that cuts a blink short', () => {
    const blinking = run([{ type: 'blink', now: T0 }]);
    const jumping = moodReducer(blinking, { type: 'message', now: T0 + 50, urgent: false });
    expect(view(jumping).seq).toBe(view(blinking).seq + 1);
    const tapping = run([
      { type: 'unread', now: T0, count: 1 },
      { type: 'tick', now: T0 + 2 * MIN },
    ]);
    expect(view(tapping)).toMatchObject({ mood: 'tapGlass', seq: 1 });
  });
});
