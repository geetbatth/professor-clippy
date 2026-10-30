import type { ReactNode } from 'react';
import { useNow } from '../hooks/useNow';
import type { UnreadStack } from '../hooks/useUnread';
import { AskCard } from './AskCard';
import { MessageCard } from './MessageCard';
import './cards.css';

/** The unread stack, newest first, with `footer` (the Tell Clippy box) pinned below it. */
export function NotesTab({ stack, footer }: { stack: UnreadStack; footer?: ReactNode }) {
  const now = useNow(30_000);
  return (
    <div className="notes">
      <div className="notes-main">
        {stack.messages.length === 0 ? (
          <div className="empty">
            <p className="empty-title">Inbox zero!</p>
            <p>Not a single note. Professor Clippy is mildly impressed.</p>
          </div>
        ) : (
          <NoteCards stack={stack} now={now} />
        )}
      </div>
      {footer}
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
