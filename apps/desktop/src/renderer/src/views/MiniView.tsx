import type { CSSProperties, ReactNode } from 'react';
import { WINDOW_SIZES } from '../../../main/window/windowApi';
import { spotOn } from '../clippy/poses';
import './MiniView.css';

/** The unread badge sits on the brim of his mortarboard as he peeks out of the canister. */
const BADGE_SPOT = spotOn('mini', 0.8, 0.07);
const BADGE_STYLE: CSSProperties = { left: `${BADGE_SPOT.x * 100}%`, top: `${BADGE_SPOT.y * 100}%` };

/** Mini mode: just Clippy, sunk into his canister on the desktop, with an unread badge on his hat. */
export function MiniView({ clippy, unread, urgent, onBadgeClick }: { clippy: ReactNode; unread: number; urgent: boolean; onBadgeClick: () => void }) {
  return (
    <div className="mini" style={WINDOW_SIZES.mini}>
      {clippy}
      {unread > 0 && (
        <button
          className={`badge${urgent ? ' badge--urgent' : ''}`}
          style={BADGE_STYLE}
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
