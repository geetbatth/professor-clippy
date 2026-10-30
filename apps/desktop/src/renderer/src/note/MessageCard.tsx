import type { Message } from '@clippy/shared/schemas';
import { CardMeta } from './CardMeta';
import { SnoozeMenu } from './SnoozeMenu';

/** A note or fired reminder on the stack. The agent's text is shown verbatim. */
export function MessageCard({ m, now, onDone, onSnooze }: { m: Message; now: number; onDone: () => void; onSnooze: (until: number) => void }) {
  return (
    <article className={`card card--${m.kind}${m.urgent ? ' card--urgent' : ''}`}>
      <CardMeta m={m} now={now} />
      {m.kind === 'reminder' && (
        <div className="card-kind">
          ⏰ Reminder{m.missed && <span className="card-missed"> · missed while you were away</span>}
        </div>
      )}
      {m.title && <h3 className="card-title">{m.title}</h3>}
      <p className="card-body">{m.body}</p>
      <footer className="card-actions">
        <button className="btn btn-done" onClick={onDone}>
          ✓ Done
        </button>
        <SnoozeMenu onSnooze={onSnooze} />
      </footer>
    </article>
  );
}
