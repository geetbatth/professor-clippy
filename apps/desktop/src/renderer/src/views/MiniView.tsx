import type { ReactNode } from 'react';
import './MiniView.css';

/** Mini mode: just Clippy standing on the desktop, with an unread badge on his hat. */
export function MiniView({ clippy, unread, urgent, onBadgeClick }: { clippy: ReactNode; unread: number; urgent: boolean; onBadgeClick: () => void }) {
  return (
    <div className="mini">
      {clippy}
      {unread > 0 && (
        <button
          className={`badge${urgent ? ' badge--urgent' : ''}`}
          data-solid=""
          onClick={onBadgeClick}
          title={`${unread} unread`}
          aria-label={`${unread} unread notes`}
        >
          {unread > 99 ? '99+' : unread}
        </button>
      )}
    </div>
  );
}
