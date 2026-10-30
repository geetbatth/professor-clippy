import { useState } from 'react';
import type { Message } from '@clippy/shared/schemas';
import { CardMeta } from './CardMeta';
import { SnoozeMenu } from './SnoozeMenu';

export interface AskCardProps {
  m: Message;
  now: number;
  onAnswer: (text: string) => Promise<void>;
  onDone: () => void;
  onSnooze: (until: number) => void;
}

/** A question from an agent: one-click option buttons, or a free-text answer. */
export function AskCard({ m, now, onAnswer, onDone, onSnooze }: AskCardProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string>();

  const answer = async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(undefined);
    try {
      await onAnswer(trimmed);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <article className={`card card--ask${m.urgent ? ' card--urgent' : ''}`}>
      <CardMeta m={m} now={now} />
      <div className="card-kind">❓ Question</div>
      {m.title && <h3 className="card-title">{m.title}</h3>}
      <p className="card-body">{m.body}</p>
      {m.answer ? (
        <p className="card-answer">
          Answered: <strong>{m.answer}</strong>
        </p>
      ) : (
        <>
          {m.options && m.options.length > 0 && (
            <div className="ask-options">
              {m.options.map((o) => (
                <button key={o} className="btn btn-option" disabled={sending} onClick={() => void answer(o)}>
                  {o}
                </button>
              ))}
            </div>
          )}
          <form
            className="ask-free"
            onSubmit={(e) => {
              e.preventDefault();
              void answer(text);
            }}
          >
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={m.options?.length ? 'Or type an answer…' : 'Type your answer…'}
              aria-label="Answer"
            />
            <button className="btn btn-done" type="submit" disabled={sending || !text.trim()}>
              Answer
            </button>
          </form>
          {error && <p className="card-error">{error}</p>}
        </>
      )}
      <footer className="card-actions card-actions--quiet">
        <button className="btn btn-ghost" onClick={onDone}>
          Dismiss
        </button>
        <SnoozeMenu onSnooze={onSnooze} />
      </footer>
    </article>
  );
}
