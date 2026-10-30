import { memo } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';
import { useCursor } from '../hooks/useCursor';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { Clippy, type ClippyProps } from './Clippy';
import { leansToCursor } from './poses';

/**
 * Clippy who leans a little towards the global cursor. The cursor state lives here (memoised),
 * so the 20 Hz cursor feed re-renders only Clippy, not the whole app; and only while his mood
 * leans at all and motion isn't reduced, so otherwise it doesn't re-render him either.
 */
export const TrackingClippy = memo(function TrackingClippy({ shell, ...props }: Omit<ClippyProps, 'look'> & { shell: ClippyWindowShell }) {
  const reduced = useReducedMotion();
  const look = useCursor(shell, leansToCursor(props.mood) && !reduced);
  return <Clippy {...props} look={look} />;
});
