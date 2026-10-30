import { useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Page } from '@clippy/shared/schemas';
import { PAGE_COLORS } from '@clippy/shared/theme';
import { useNow } from '../hooks/useNow';
import type { PadPages } from '../hooks/usePages';
import { PageEditor } from './PageEditor';
import { authorBadge, firstLine, padSections, pageMeta, searchPages } from './padList';
import { timeAgo } from './timeAgo';
import './cards.css';
import './PadTab.css';

/** The title a new page starts with (selected, so typing replaces it). */
const NEW_PAGE_TITLE = 'Untitled';

type View = { kind: 'list' } | { kind: 'page'; page: Page; fresh: boolean } | { kind: 'archived' };

export interface PadTabProps {
  api: ClippyWindowApi;
  pad: PadPages;
  /** True while a page has focus (or an unsettled conflict): the note must not tuck itself away. */
  onActive(active: boolean): void;
}

/** The Pad: your pages (pinned, then recent), search, a new page, one page open, and the archive. */
export function PadTab({ api, pad, onActive }: PadTabProps) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [error, setError] = useState<string>();
  const openId = view.kind === 'page' ? view.page.id : undefined;

  // The open page was archived (by Clippy, say) or deleted elsewhere: back to the list.
  useEffect(() => {
    if (openId && pad.archived.some((p) => p.id === openId)) setView({ kind: 'list' });
  }, [openId, pad.archived]);
  useEffect(() => {
    if (!openId) return;
    return api.on('page:deleted', ({ id }) => {
      if (id === openId) setView({ kind: 'list' });
    });
  }, [api, openId]);

  const newPage = async () => {
    try {
      setView({ kind: 'page', page: await api.createPage({ title: NEW_PAGE_TITLE }), fresh: true });
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (view.kind === 'page') {
    return (
      <div className="pad pad--page">
        <button type="button" className="pad-back" onClick={() => setView({ kind: 'list' })}>
          ‹ All pages
        </button>
        <PageEditor
          key={view.page.id}
          api={api}
          page={view.page}
          selectTitle={view.fresh}
          onActive={onActive}
          onArchived={() => setView({ kind: 'list' })}
        />
      </div>
    );
  }
  if (view.kind === 'archived') return <ArchivedPages api={api} pages={pad.archived} onBack={() => setView({ kind: 'list' })} />;
  return (
    <PageList pad={pad} error={error} onOpen={(page) => setView({ kind: 'page', page, fresh: false })} onNew={() => void newPage()} onArchived={() => setView({ kind: 'archived' })} />
  );
}

function PageList({ pad, error, onOpen, onNew, onArchived }: { pad: PadPages; error?: string; onOpen(page: Page): void; onNew(): void; onArchived(): void }) {
  const [q, setQ] = useState('');
  const now = useNow(30_000);
  const found = searchPages(pad.pages, q);
  const { pinned, recent } = padSections(found);
  return (
    <div className="pad">
      <div className="pad-top">
        <input
          className="field-input pad-search"
          type="search"
          value={q}
          placeholder="Search pages…"
          aria-label="Search pages"
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="btn btn-done pad-new" onClick={onNew}>
          + New
        </button>
      </div>
      {error && <p className="card-error">{error}</p>}
      {pad.loaded && found.length === 0 && (
        <div className="pad-empty">
          {q.trim() ? (
            <p>Nothing matches. Not even a footnote.</p>
          ) : (
            <>
              <p className="empty-title">A blank pad!</p>
              <p>Press + New, or tell Clippy "jot down: call Dave about the invoice".</p>
            </>
          )}
        </div>
      )}
      {pinned.length > 0 && <PageSection label="Pinned" pages={pinned} now={now} onOpen={onOpen} />}
      {recent.length > 0 && <PageSection label="Recent" pages={recent} now={now} onOpen={onOpen} />}
      {pad.archived.length > 0 && (
        <button type="button" className="pad-label pad-archived" onClick={onArchived}>
          Archived · {pad.archived.length} ›
        </button>
      )}
    </div>
  );
}

/** A coloured page's chip colour, for the edge of its card. */
function colorEdge(page: Page) {
  const swatch = PAGE_COLORS.find((c) => c.id === page.color)?.swatch;
  return swatch ? { borderLeft: `4px solid ${swatch}` } : undefined;
}

function PageSection({ label, pages, now, onOpen }: { label: string; pages: Page[]; now: number; onOpen(page: Page): void }) {
  return (
    <section className="pad-section">
      <h2 className="pad-label">{label}</h2>
      <div className="stack">
        {pages.map((p) => {
          const badge = authorBadge(p);
          return (
            <button key={p.id} type="button" className="card pad-card" style={colorEdge(p)} onClick={() => onOpen(p)}>
              <span className="pad-card-head">
                {p.unseen && <span className="pad-new-dot" title="New: not opened yet" />}
                <span className="pad-card-title">{p.title}</span>
                {badge && <span className="pad-badge">{badge}</span>}
                {p.pinned && (
                  <span className="pad-pin" aria-label="Pinned">
                    📌
                  </span>
                )}
              </span>
              <span className="pad-card-line">{firstLine(p.body) || 'Empty page'}</span>
              <span className="pad-card-meta">{pageMeta(p, now)}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** Archived pages: restore one, or delete it for good (after a second click to confirm). */
function ArchivedPages({ api, pages, onBack }: { api: ClippyWindowApi; pages: Page[]; onBack(): void }) {
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState<string>();
  const now = useNow(60_000);
  const run = (action: Promise<unknown>) =>
    action.then(
      () => setError(undefined),
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    );
  return (
    <div className="pad">
      <button type="button" className="pad-back" onClick={onBack}>
        ‹ All pages
      </button>
      <h2 className="pad-label">Archived</h2>
      {error && <p className="card-error">{error}</p>}
      {pages.length === 0 && <p className="pad-empty">Nothing archived.</p>}
      <div className="stack">
        {pages.map((p) => (
          <article key={p.id} className="card pad-card pad-card--archived" style={colorEdge(p)}>
            <span className="pad-card-head">
              <span className="pad-card-title">{p.title}</span>
              {authorBadge(p) && <span className="pad-badge">{authorBadge(p)}</span>}
            </span>
            <span className="pad-card-line">{firstLine(p.body) || 'Empty page'}</span>
            <span className="pad-card-meta">archived {p.archivedAt === null ? '' : timeAgo(p.archivedAt, now)}</span>
            {confirming === p.id ? (
              <div className="card-actions">
                <span className="pad-confirm">Delete it for good?</span>
                <button type="button" className="btn pad-delete" onClick={() => void run(api.deletePage(p.id))}>
                  Delete
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirming(undefined)}>
                  Keep it
                </button>
              </div>
            ) : (
              <div className="card-actions">
                <button type="button" className="btn btn-option" onClick={() => void run(api.restorePage(p.id))}>
                  Restore
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => setConfirming(p.id)}>
                  Delete forever
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
    </div>
  );
}
