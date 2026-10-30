import { memo } from 'react';
import type { ClippyWindowShell } from '../../../main/window/windowApi';
import { useCursor } from '../hooks/useCursor';
import { Clippy, type ClippyProps } from './Clippy';

/**
 * Clippy who leans a little towards the global cursor. The cursor state lives here (memoised),
 * so the 20 Hz cursor feed re-renders only Clippy, not the whole app.
 */
export const TrackingClippy = memo(function TrackingClippy({ shell, ...props }: Omit<ClippyProps, 'look'> & { shell: ClippyWindowShell }) {
  const look = useCursor(shell);
  return <Clippy {...props} look={look} />;
});
