import type { Message } from '@clippy/shared/schemas';
import { timeAgo } from './timeAgo';

/** "claude-code · payments-api · 4 min ago", plus the URGENT rubber stamp. */
export function CardMeta({ m, now }: { m: Message; now: number }) {
  return (
    <>
      <header className="card-meta">
        <span className="card-sender">{m.sender}</span>
        {m.project && <span className="card-project">{m.project}</span>}
        <time dateTime={new Date(m.createdAt).toISOString()}>{timeAgo(m.createdAt, now)}</time>
      </header>
      {m.urgent && <span className="stamp">Urgent</span>}
    </>
  );
}
