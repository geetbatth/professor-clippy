import type { ReactNode } from 'react';
import './ExpandedView.css';

/**
 * Expanded mode: Clippy stays in the top-right corner (exactly where mini Clippy was),
 * clipped onto the top of the sticky note, with room for his speech bubble on the left.
 */
export function ExpandedView({ clippy, bubble, note }: { clippy: ReactNode; bubble: ReactNode; note: ReactNode }) {
  return (
    <div className="expanded">
      {note}
      {bubble}
      <div className="expanded-clippy">{clippy}</div>
    </div>
  );
}
