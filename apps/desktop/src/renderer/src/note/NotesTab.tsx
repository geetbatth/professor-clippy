import { useState, type ReactNode } from 'react';
import { useNow } from '../hooks/useNow';
import type { UnreadStack } from '../hooks/useUnread';
import { AskCard } from './AskCard';
import { MessageCard } from './MessageCard';
import { clearable } from './unreadStack';
import './cards.css';

/**
 * The unread stack, newest first, with `footer` (the Tell Clippy box) pinned below it. With
 * nothing unread, a "History ›" link (`onHistory`) leads to what has been dealt with.
 */
export function NotesTab({ stack, footer, onHistory }: { stack: UnreadStack; footer?: ReactNode; onHistory?: () => void }) {
  const now = useNow(30_000);
  return (
    <div className="notes">
      <div className="notes-main">
        {stack.messages.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Inbox zero!</p>
            <p>Not a single note. Professor Clippy is mildly impressed.</p>
            {onHistory && (
              <button type="button" className="empty-link" onClick={onHistory}>
                History ›
              </button>
            )}
          </div>
        ) : (
          <>
            <ClearAll stack={stack} />
            <NoteCards stack={stack} now={now} />
          </>
        )}
      </div>
      {footer}
    </div>
  );
}

/**
 * "Clear all" above the stack, once there are two or more notes or reminders: one click asks
 * "Clear N?", the second sends them all to History. Questions stay (an agent may be waiting).
 */
function ClearAll({ stack }: { stack: UnreadStack }) {
  const [confirming, setConfirming] = useState(false);
  const count = clearable(stack.messages).length;
  if (count < 2) return null;
  const label = `${count} notes`;
  return (
    <div className="clear-bar">
      {confirming ? (
        <>
          <span>Clear {label}?</span>
          <button
            type="button"
            className="clear-btn clear-btn--yes"
            onClick={() => {
              setConfirming(false);
              void stack.clearAll();
            }}
          >
            Clear
          </button>
          <button type="button" className="clear-btn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="clear-btn" title="Send every note and reminder to History (questions stay)" onClick={() => setConfirming(true)}>
          Clear all
        </button>
      )}
    </div>
  );
}

function NoteCards({ stack, now }: { stack: UnreadStack; now: number }) {
  return (
    <div className="stack">
      {stack.messages.map((m) =>
        m.kind === 'ask' ? (
          <AskCard
            key={m.id}
            m={m}
            now={now}
            onAnswer={(text) => stack.answer(m.id, text)}
            onDone={() => void stack.markDone(m.id)}
            onSnooze={(until) => void stack.snooze(m.id, until)}
          />
        ) : (
          <MessageCard
            key={m.id}
            m={m}
            now={now}
            onDone={() => void stack.markDone(m.id)}
            onSnooze={(until) => void stack.snooze(m.id, until)}
          />
        ),
      )}
    </div>
  );
}
