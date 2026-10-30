/**
 * Professor Clippy's mood state machine (pure; `useClippyMood` drives it with timers).
 *
 * Resting ("base") moods follow the situation: `think` while the brain works, `sleep`
 * after 10 idle minutes, `read` while the note is open with something on it, else `idle`.
 * Short "transient" moods play on top (one at a time, then a small queue):
 * `blink`, `wake`, `jump` (the bigger antics when `big`), `tapGlass`, `celebrate`.
 *
 * Nagging: unread notes nobody has reacted to get a `tapGlass` every 2 minutes and a
 * big jump every 10 minutes; an urgent message gets the big jump straight away.
 */

export type Mood = 'idle' | 'blink' | 'read' | 'sleep' | 'wake' | 'jump' | 'tapGlass' | 'think' | 'celebrate';
export type BaseMood = Extract<Mood, 'idle' | 'read' | 'sleep' | 'think'>;
export type TransientMood = Exclude<Mood, BaseMood>;

export const MOODS: readonly Mood[] = ['idle', 'blink', 'read', 'sleep', 'wake', 'jump', 'tapGlass', 'think', 'celebrate'];

export const MOOD_TIMING = {
  /** No activity and nothing unread for this long → sleep. */
  sleepAfterMs: 10 * 60_000,
  /** Unread notes ignored this long → tap on the glass (repeats at this interval). */
  tapAfterMs: 2 * 60_000,
  /** Unread notes ignored this long → bigger antics (repeats at this interval). */
  bigAfterMs: 10 * 60_000,
} as const;

/** How long each transient mood plays. CSS keyframes use the same durations. */
export const TRANSIENT_MS: Readonly<Record<TransientMood, number>> = {
  blink: 180,
  wake: 1200,
  jump: 1100,
  tapGlass: 1600,
  celebrate: 2400,
};
/** The big (urgent / long-ignored) jump: a somersault, so it takes longer. */
export const BIG_JUMP_MS = 1800;

const MAX_QUEUE = 3;

interface Playing {
  mood: TransientMood;
  big: boolean;
}

export interface MoodState {
  expanded: boolean;
  thinking: boolean;
  asleep: boolean;
  unread: number;
  lastActivityAt: number;
  /** When the current unread notes started being ignored (undefined when nothing is unread). */
  ignoredSince?: number;
  lastNagAt?: number;
  lastBigAt?: number;
  current?: Playing & { until: number };
  queue: Playing[];
  /** Increments every time a transient starts (lets sound/effects react to repeats). */
  seq: number;
}

export type MoodEvent =
  | { type: 'tick'; now: number }
  | { type: 'activity'; now: number }
  | { type: 'message'; now: number; urgent: boolean }
  | { type: 'unread'; now: number; count: number }
  | { type: 'thinking'; now: number; thinking: boolean }
  | { type: 'expanded'; now: number; expanded: boolean }
  | { type: 'blink'; now: number };

export interface MoodView {
  mood: Mood;
  big: boolean;
  seq: number;
}

export function initialMoodState(now: number): MoodState {
  return { expanded: false, thinking: false, asleep: false, unread: 0, lastActivityAt: now, queue: [], seq: 0 };
}

export function baseMood(s: MoodState): BaseMood {
  if (s.thinking) return 'think';
  if (s.asleep) return 'sleep';
  if (s.expanded && s.unread > 0) return 'read';
  return 'idle';
}

export function moodView(s: MoodState): MoodView {
  if (s.current) return { mood: s.current.mood, big: s.current.big, seq: s.seq };
  return { mood: baseMood(s), big: false, seq: s.seq };
}

function duration(p: Playing): number {
  return p.mood === 'jump' && p.big ? BIG_JUMP_MS : TRANSIENT_MS[p.mood];
}

function start(s: MoodState, p: Playing, now: number): MoodState {
  return { ...s, current: { ...p, until: now + duration(p) }, seq: s.seq + 1 };
}

/** Play a transient now, or queue it behind the current one. A blink never interrupts or queues. */
function play(s: MoodState, p: Playing, now: number): MoodState {
  if (!s.current || s.current.mood === 'blink') return start(s, p, now);
  if (p.mood === 'blink') return s;
  const last = s.queue.at(-1) ?? s.current;
  if (last.mood === p.mood && last.big === p.big) return s;
  if (s.queue.length >= MAX_QUEUE) return s;
  return { ...s, queue: [...s.queue, p] };
}

/** Finish transients whose time is up, starting queued ones. */
function advance(s: MoodState, now: number): MoodState {
  let next = s;
  while (next.current && now >= next.current.until) {
    const [head, ...rest] = next.queue;
    next = head ? start({ ...next, queue: rest }, head, now) : { ...next, current: undefined };
  }
  return next;
}

/** The user did something: restart the idle and ignore clocks, and wake up. */
function noteActivity(s: MoodState, now: number): MoodState {
  let next: MoodState = { ...s, lastActivityAt: now };
  if (next.unread > 0) next = { ...next, ignoredSince: now, lastNagAt: now, lastBigAt: undefined };
  if (next.asleep) next = play({ ...next, asleep: false }, { mood: 'wake', big: false }, now);
  return next;
}

/** Sleep and nag timers. */
function checkTimers(s: MoodState, now: number): MoodState {
  if (s.thinking) return s;
  if (s.unread === 0) {
    if (!s.asleep && now - s.lastActivityAt >= MOOD_TIMING.sleepAfterMs) return { ...s, asleep: true };
    return s;
  }
  const since = s.ignoredSince ?? now;
  if (now - since >= MOOD_TIMING.bigAfterMs && (s.lastBigAt === undefined || now - s.lastBigAt >= MOOD_TIMING.bigAfterMs)) {
    return play({ ...s, asleep: false, lastBigAt: now, lastNagAt: now }, { mood: 'jump', big: true }, now);
  }
  if (now - (s.lastNagAt ?? since) >= MOOD_TIMING.tapAfterMs) {
    return play({ ...s, asleep: false, lastNagAt: now }, { mood: 'tapGlass', big: false }, now);
  }
  return s;
}

export function moodReducer(state: MoodState, event: MoodEvent): MoodState {
  const now = event.now;
  const s = advance(state, now);
  switch (event.type) {
    case 'tick':
      return checkTimers(s, now);
    case 'activity':
      return noteActivity(s, now);
    case 'expanded':
      return noteActivity({ ...s, expanded: event.expanded }, now);
    case 'message': {
      // A message also restarts the idle clock, so he doesn't nod straight back off.
      let next: MoodState = { ...s, lastActivityAt: now, lastNagAt: now };
      if (event.urgent) next = { ...next, lastBigAt: now };
      if (next.asleep) next = play({ ...next, asleep: false }, { mood: 'wake', big: false }, now);
      return play(next, { mood: 'jump', big: event.urgent }, now);
    }
    case 'unread': {
      const prev = s.unread;
      const count = Math.max(0, event.count);
      if (count === 0) {
        const cleared: MoodState = { ...s, unread: 0, ignoredSince: undefined, lastNagAt: undefined, lastBigAt: undefined };
        // Inbox zero is the user's doing: count it as activity, and throw the hat.
        return prev > 0 ? play({ ...cleared, lastActivityAt: now }, { mood: 'celebrate', big: false }, now) : cleared;
      }
      // A fresh batch of unread notes starts the ignore clock.
      if (prev === 0) return { ...s, unread: count, ignoredSince: now, lastNagAt: now, lastBigAt: s.lastBigAt };
      return { ...s, unread: count };
    }
    case 'thinking': {
      const next = { ...s, thinking: event.thinking };
      return event.thinking && next.asleep ? play({ ...next, asleep: false }, { mood: 'wake', big: false }, now) : next;
    }
    case 'blink':
      return baseMood(s) === 'idle' && !s.current ? play(s, { mood: 'blink', big: false }, now) : s;
  }
}

/** When the current transient ends (for scheduling the next tick), if one is playing. */
export function nextTransitionAt(s: MoodState): number | undefined {
  return s.current?.until;
}
