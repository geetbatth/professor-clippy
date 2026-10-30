import { useCallback, useEffect, useReducer, useRef } from 'react';
import { initialMoodState, moodReducer, moodView, nextTransitionAt, type MoodView } from './mood';

export interface MoodInputs {
  unread: number;
  thinking: boolean;
  expanded: boolean;
}

export interface ClippyMood extends MoodView {
  /** The user did something (click, key, hover): wakes him and restarts the ignore clock. */
  activity(): void;
  /** A new agent message arrived. */
  message(urgent: boolean): void;
}

/** Slow tick for the 2- and 10-minute timers. */
const TICK_MS = 5_000;
/** Activity is throttled: hovering about shouldn't flood the reducer. */
const ACTIVITY_THROTTLE_MS = 1_000;

/** Drives the pure mood machine (`mood.ts`) with real time, blinks and the app's state. */
export function useClippyMood({ unread, thinking, expanded }: MoodInputs): ClippyMood {
  const [state, dispatch] = useReducer(moodReducer, Date.now(), initialMoodState);

  useEffect(() => dispatch({ type: 'unread', now: Date.now(), count: unread }), [unread]);
  useEffect(() => dispatch({ type: 'thinking', now: Date.now(), thinking }), [thinking]);
  useEffect(() => dispatch({ type: 'expanded', now: Date.now(), expanded }), [expanded]);

  // Long timers.
  useEffect(() => {
    const id = setInterval(() => dispatch({ type: 'tick', now: Date.now() }), TICK_MS);
    return () => clearInterval(id);
  }, []);

  // End the current transient on time.
  const until = nextTransitionAt(state);
  useEffect(() => {
    if (until === undefined) return;
    const id = setTimeout(() => dispatch({ type: 'tick', now: Date.now() }), Math.max(0, until - Date.now()));
    return () => clearTimeout(id);
  }, [until]);

  // Blink every 2.5–6.5 s (the reducer ignores blinks unless he is idle).
  useEffect(() => {
    let id: ReturnType<typeof setTimeout>;
    const schedule = () => {
      id = setTimeout(() => {
        dispatch({ type: 'blink', now: Date.now() });
        schedule();
      }, 2_500 + Math.random() * 4_000);
    };
    schedule();
    return () => clearTimeout(id);
  }, []);

  const lastActivity = useRef(0);
  const activity = useCallback(() => {
    const now = Date.now();
    if (now - lastActivity.current < ACTIVITY_THROTTLE_MS) return;
    lastActivity.current = now;
    dispatch({ type: 'activity', now });
  }, []);
  const message = useCallback((urgent: boolean) => dispatch({ type: 'message', now: Date.now(), urgent }), []);

  return { ...moodView(state), activity, message };
}
