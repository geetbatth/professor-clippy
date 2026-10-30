import { useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Message, StandingOrder } from '@clippy/shared/schemas';
import { useNow } from '../hooks/useNow';
import { CardMeta } from './CardMeta';
import { orderLabel } from './orderLabel';
import './cards.css';
import './HistoryTab.css';

const SEARCH_DEBOUNCE_MS = 250;
const RECENT_LIMIT = 50;

/** Search everything that's been dealt with. An empty box shows the most recent. */
export function HistoryTab({ api }: { api: ClippyWindowApi }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Message[] | undefined>();
  const [error, setError] = useState<string>();
  const [orders, setOrders] = useState<StandingOrder[]>([]);
  const now = useNow(60_000);

  useEffect(() => {
    let live = true;
    const id = setTimeout(
      () => {
        const query = q.trim();
        const load = query
          ? api.searchHistory(query)
          : api.listMessages({ state: 'done' }).then((list) => list.filter((m) => m.kind !== 'chat').slice(0, RECENT_LIMIT));
        load.then(
          (list) => {
            if (!live) return;
            setResults(list);
            setError(undefined);
            // The wording of the orders that answered some of these asks (active ones only).
            if (list.some((m) => m.orderId)) api.listOrders().then((o) => live && setOrders(o), () => {});
          },
          (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
        );
      },
      q ? SEARCH_DEBOUNCE_MS : 0,
    );
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [api, q]);

  return (
    <div className="history">
      <input
        className="field-input history-search"
        type="search"
        value={q}
        placeholder="Search history…"
        aria-label="Search history"
        onChange={(e) => setQ(e.target.value)}
      />
      {error && <p className="card-error">{error}</p>}
      {results?.length === 0 && <p className="history-empty">{q.trim() ? 'Nothing matches. Not even a footnote.' : 'No history yet.'}</p>}
      <div className="stack">
        {results?.map((m) => (
          <article key={m.id} className="card card--history">
            <CardMeta m={m} now={now} />
            {m.title && <h3 className="card-title">{m.title}</h3>}
            <p className="card-body history-body">{m.body}</p>
            {m.answer && (
              <p className="card-answer">
                Answered: <strong>{m.answer}</strong>
                {m.answeredVia && <span className="history-via"> via {m.answeredVia}</span>}
              </p>
            )}
            {m.orderId && <p className="history-via">{orderLabel(m.orderId, orders)}</p>}
          </article>
        ))}
      </div>
    </div>
  );
}
