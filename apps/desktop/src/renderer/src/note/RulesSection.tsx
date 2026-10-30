import { useCallback, useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { StandingOrder } from '@clippy/shared/schemas';
import './RulesSection.css';

const MAX_ORDER_LENGTH = 500;

/**
 * Settings → what Clippy does on his own: the standing orders he answers agents' questions by.
 * Self-contained (it loads and saves through `api`), so another list can sit beside it.
 */
export function RulesSection({ api }: { api: ClippyWindowApi }) {
  return (
    <div className="rules">
      <StandingOrders api={api} />
    </div>
  );
}

/** "When an agent asks X, answer: Y" instructions: the active ones, a × to cancel each, and an add field. */
function StandingOrders({ api }: { api: ClippyWindowApi }) {
  const [orders, setOrders] = useState<StandingOrder[]>();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : String(err));
  const reload = useCallback(() => api.listOrders().then(setOrders), [api]);

  useEffect(() => {
    reload().catch(fail);
  }, [reload]);

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.addOrder(trimmed);
      setText('');
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (id: string) => {
    setError(undefined);
    try {
      await api.cancelOrder(id);
      await reload();
    } catch (err) {
      fail(err);
    }
  };

  return (
    <fieldset className="setting-group">
      <legend>Standing orders</legend>
      <span className="setting-hint">
        Tell me once how to answer an agent's question and I'll answer it for you from then on. Tell me in chat, or add one here.
      </span>
      {orders?.length === 0 && <span className="setting-hint rules-empty">None yet. Try: When an agent asks which branch to use, answer: staging</span>}
      <ul className="rules-list">
        {orders?.map((o) => (
          <li key={o.id} className="rules-item">
            <span className="rules-text">{o.text}</span>
            <button className="btn btn-ghost rules-remove" aria-label={`Cancel standing order: ${o.text}`} title="Cancel this order" onClick={() => void cancel(o.id)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <form
        className="rules-add"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <input
          className="field-input"
          value={text}
          maxLength={MAX_ORDER_LENGTH}
          placeholder="When an agent asks about…, answer: …"
          aria-label="New standing order"
          onChange={(e) => setText(e.target.value)}
        />
        <button className="btn btn-done" type="submit" disabled={busy || !text.trim()}>
          Add
        </button>
      </form>
      {error && <p className="card-error">{error}</p>}
    </fieldset>
  );
}
