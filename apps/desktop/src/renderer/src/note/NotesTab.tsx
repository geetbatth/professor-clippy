import { useNow } from '../hooks/useNow';
import type { UnreadStack } from '../hooks/useUnread';
import { AskCard } from './AskCard';
import { MessageCard } from './MessageCard';
import './cards.css';

/** The unread stack, newest first. */
export function NotesTab({ stack }: { stack: UnreadStack }) {
  const now = useNow(30_000);
  if (stack.messages.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">Inbox zero!</p>
        <p>Not a single note. Professor Clippy is mildly impressed.</p>
      </div>
    );
  }
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
