import { useEffect, useReducer, useRef, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import { PAGE_TITLE_MAX, type Page, type PageChange } from '@clippy/shared/schemas';
import { PAGE_COLORS } from '@clippy/shared/theme';
import { useNow } from '../hooks/useNow';
import { createSaveController, type SaveController } from './pageSave';
import { timeAgo } from './timeAgo';
import './cards.css';
import './PadTab.css';

export interface PageEditorProps {
  api: ClippyWindowApi;
  /** The page as it was when opened; changes arrive as `page:changed`. Key the editor by page id. */
  page: Page;
  /** A new page: put the cursor in the title with "Untitled" selected. */
  selectTitle?: boolean;
  /** True while the editor has focus or an unsettled conflict, so the note does not tuck itself away. */
  onActive?(active: boolean): void;
  /** The page was archived from here. */
  onArchived?(): void;
  /**
   * In a popped-out page's window: no title field (the window's header shows it) and, under the
   * text, only the save state; colour, keep at top and archive stay in the Pad.
   */
  compact?: boolean;
}

/** "Scratch (your version)": the copy kept when the editor closes on an unsettled conflict. */
function yourVersionTitle(title: string): string {
  const suffix = ' (your version)';
  return title.slice(0, PAGE_TITLE_MAX - suffix.length) + suffix;
}

/**
 * One page: its title, the lined text that saves as you type (`pageSave.ts`), and a footer with
 * the save state, the "changed while you were typing" banner, colour, keep-at-top, pin out and
 * archive. Self-contained (it listens for the page's changes itself), so a popped-out page window
 * can show it too.
 */
export function PageEditor({ api, page, selectTitle = false, onActive, onArchived, compact = false }: PageEditorProps) {
  const [current, setCurrent] = useState(page);
  const currentRef = useRef(page);
  currentRef.current = current;
  const [text, setText] = useState(page.body);
  const [title, setTitle] = useState(page.title);
  const titleRef = useRef(title);
  titleRef.current = title;
  const titleFocused = useRef(false);
  const [focused, setFocused] = useState(false);
  const [error, setError] = useState<string>();
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const now = useNow(30_000);
  const titleInput = useRef<HTMLInputElement>(null);
  const textArea = useRef<HTMLTextAreaElement>(null);

  const [ctl] = useState<SaveController>(() =>
    createSaveController({
      text: page.body,
      base: page.updatedAt,
      save: (body, base) => api.writePage(page.id, { body, baseUpdatedAt: base }),
      onChange: bump,
      onText: setText,
    }),
  );

  useEffect(() => {
    if (page.unseen) void api.markPageSeen(page.id);
  }, [api, page]);

  // Their changes: the text goes through the save controller; title, colour and pin show at once.
  useEffect(
    () =>
      api.on('page:changed', (p) => {
        if (p.id !== page.id) return;
        ctl.remote(p);
        setCurrent((c) => (p.updatedAt >= c.updatedAt ? p : c));
        if (!titleFocused.current) setTitle(p.title);
        // It's open in front of them: they have seen it.
        if (p.unseen && p.archivedAt === null) void api.markPageSeen(p.id);
      }),
    [api, page.id, ctl],
  );

  // Leaving (page switch, tab switch, collapse; quitting or closing the window, where React does
  // not unmount, so `beforeunload` too): save what's typed.
  useEffect(() => {
    const leave = () => {
      // Left without settling a conflict (or the last save comes back refused after we've gone):
      // their version stays on the page, the typed text becomes a copy (once).
      ctl.leave((copy) => {
        api.createPage({ title: yourVersionTitle(currentRef.current.title), body: copy }).catch(() => {}); // nowhere left to say so
      });
      const t = titleRef.current.trim();
      if (t && t !== currentRef.current.title) api.writePage(page.id, { title: t }).catch(() => {}); // gone meanwhile: nothing to rename
    };
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('beforeunload', leave);
      leave();
    };
  }, [api, page.id, ctl]);

  useEffect(() => {
    if (!selectTitle) return;
    titleInput.current?.focus();
    titleInput.current?.select();
  }, [selectTitle]);

  const active = focused || ctl.state === 'conflict';
  useEffect(() => {
    onActive?.(active);
    return () => onActive?.(false);
  }, [active, onActive]);

  /** A change other than the text: after the text is saved, so the two don't trip over each other. */
  const write = async (change: PageChange) => {
    try {
      await ctl.flush();
      const result = await api.writePage(page.id, change);
      if (result.ok) {
        ctl.remote(result.page);
        setCurrent(result.page);
      }
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const commitTitle = () => {
    const t = title.trim();
    if (!t) setTitle(current.title);
    else if (t !== current.title) void write({ title: t });
  };

  /** "📌 Pin out" puts the page on the desktop; "Un-pin" takes it back (its window closes). */
  const togglePopped = async () => {
    try {
      await ctl.flush();
      setCurrent(await api.popPage(page.id, !current.popped));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const archive = async () => {
    try {
      await ctl.flush();
      await api.archivePage(page.id);
      onArchived?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const status =
    ctl.state === 'saving' || ctl.state === 'dirty'
      ? ctl.error
        ? `Couldn't save: ${ctl.error}`
        : 'Saving…'
      : `✓ Saved · ${timeAgo(ctl.savedAt, now)}`;

  return (
    <div className="page">
      <div className="page-paper" {...(current.color && { 'data-page-color': current.color })}>
        {!compact && (
          <input
            ref={titleInput}
            className="page-title"
            type="text"
            value={title}
            maxLength={PAGE_TITLE_MAX}
            aria-label="Page title"
            onChange={(e) => setTitle(e.target.value)}
            onFocus={() => {
              titleFocused.current = true;
              setFocused(true);
            }}
            onBlur={() => {
              titleFocused.current = false;
              setFocused(false);
              commitTitle();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault();
                textArea.current?.focus();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setTitle(current.title);
              }
            }}
          />
        )}
        <textarea
          ref={textArea}
          className="page-text"
          value={text}
          aria-label="Page text"
          placeholder="Write anything…"
          spellCheck
          onChange={(e) => {
            setText(e.target.value);
            ctl.edit(e.target.value);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            void ctl.flush();
          }}
        />
      </div>
      {ctl.state === 'conflict' && (
        <div className="page-conflict" role="alert">
          <span>Changed while you were typing.</span>
          <button type="button" className="btn btn-done" onClick={() => void ctl.resolve('mine')}>
            Keep mine
          </button>
          <button type="button" className="btn btn-option" onClick={() => void ctl.resolve('theirs')}>
            Use theirs
          </button>
        </div>
      )}
      {error && <p className="card-error">{error}</p>}
      <div className="page-footer">
        {ctl.state !== 'conflict' && (
          <span className={`page-status${ctl.error ? ' page-status--bad' : ''}`} role="status">
            {status}
          </span>
        )}
        {!compact && (
          <>
            <span className="page-footer-gap" />
            <button
              type="button"
              className="btn btn-ghost"
              aria-pressed={current.popped}
              title={current.popped ? 'Take this page off the desktop (it stays in the Pad)' : 'Put this page on the desktop as its own sticky'}
              onClick={() => void togglePopped()}
            >
              {current.popped ? 'Un-pin' : '📌 Pin out'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void archive()}>
              Archive
            </button>
          </>
        )}
      </div>
      {!compact && (
        <div className="page-footer page-footer--small">
          <span className="page-colors" role="radiogroup" aria-label="Paper colour">
            <button
              type="button"
              role="radio"
              aria-checked={current.color === null}
              className="page-color page-color--theme"
              title="Same as the note"
              aria-label="Same as the note"
              onClick={() => void write({ color: null })}
            />
            {PAGE_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={current.color === c.id}
                className="page-color"
                style={{ background: c.swatch }}
                title={c.label}
                aria-label={c.label}
                onClick={() => void write({ color: c.id })}
              />
            ))}
          </span>
          <span className="page-footer-gap" />
          <button
            type="button"
            className={`btn btn-ghost page-keep${current.pinned ? ' page-keep--on' : ''}`}
            aria-pressed={current.pinned}
            title="Keep this page at the top of the Pad"
            onClick={() => void write({ pinned: !current.pinned })}
          >
            {current.pinned ? '★ Kept at top' : '☆ Keep at top'}
          </button>
        </div>
      )}
    </div>
  );
}
