import type { ReactNode } from 'react';
import { WINDOW_SIZES } from '../../../main/window/windowApi';
import './ExpandedView.css';

/**
 * Expanded mode: Clippy stays in the top-right corner (exactly where mini Clippy was), standing
 * on the sticky note's top-right corner, with room for his speech bubble on the left.
 */
export function ExpandedView({ clippy, bubble, note }: { clippy: ReactNode; bubble: ReactNode; note: ReactNode }) {
  return (
    <div className="expanded" style={WINDOW_SIZES.expanded}>
      {note}
      {bubble}
      <div className="expanded-clippy" style={WINDOW_SIZES.mini}>
        {clippy}
      </div>
    </div>
  );
}
