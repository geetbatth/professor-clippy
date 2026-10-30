import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import type { Page } from '@clippy/shared/schemas';
import { PAGE_HEADER_HEIGHT, type PageWindowShell } from '../../../main/window/windowApi';
import { useSettings } from '../hooks/useSettings';
import { useTheme } from '../hooks/useTheme';
import { PageEditor } from '../note/PageEditor';
import type { Runtime } from '../runtime';
import './PageWindow.css';

/** Shell stand-in for a plain browser: nothing to shrink. */
const browserPageShell: PageWindowShell = { setCollapsed: () => {}, resizeStart: () => {}, resizeMove: () => {}, resizeEnd: () => {} };

/** A new page window's size in the browser preview (`PAGE_WINDOW_SIZE` in main). */
const PREVIEW_SIZE = { width: 260, height: 220 };

/**
 * A Pad page popped out onto the desktop (`?page=<id>`): a small sticky in the page's colour (or
 * the theme's paper) with a drag header showing the title, "—" to shrink it to the header and "×"
 * to put it back in the Pad (the page stays; main closes the window), over the page's editor, and
 * a grip in the bottom-right corner to resize it.
 */
export function PageWindow({ runtime, id: asked }: { runtime: Runtime; id: string }) {
  const { api } = runtime;
  /** The page's id (in the preview, `?page=` may name a sample page by title instead). */
  const [id, setId] = useState(asked);
  const settingsState = useSettings(api);
  useTheme(api, settingsState.settings, settingsState.refresh);
  const shell = window.clippyPageWindow ?? browserPageShell;
  /** The page as first loaded: what the editor starts from (it follows changes itself). */
  const [initial, setInitial] = useState<Page>();
  /** The page as it is now: for the header and the colour. */
  const [page, setPage] = useState<Page>();
  const [gone, setGone] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    // The mock's sample pages get new ids on every load: `?mock=1&page=Scratch` finds one by title.
    const load = runtime.mock
      ? api.getPage(id).catch(async () => {
          const byTitle = (await api.listPages({})).find((p) => p.title === id);
          if (!byTitle) throw new Error(`No page ${id}`);
          setId(byTitle.id);
          return byTitle;
        })
      : api.getPage(id);
    load.then(
      (p) => {
        if (!live) return;
        setInitial(p);
        setPage((now) => (now && now.updatedAt > p.updatedAt ? now : p));
      },
      () => live && setGone(true),
    );
    const offChanged = api.on('page:changed', (p) => {
      if (p.id === id) setPage((now) => (now && now.updatedAt > p.updatedAt ? now : p));
    });
    const offDeleted = api.on('page:deleted', (d) => {
      if (d.id === id) setGone(true);
    });
    return () => {
      live = false;
      offChanged();
      offDeleted();
    };
  }, [api, id, runtime.mock]);

  useEffect(() => {
    if (page) document.title = page.title;
  }, [page]);

  const collapse = (next: boolean) => {
    setCollapsed(next);
    shell.setCollapsed(next);
  };

  const unpop = async () => {
    // Leaving the text box saves what is typed (and the window's `beforeunload` does again).
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    try {
      await api.popPage(id, false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const title = page?.title ?? (gone ? 'Page gone' : '');
  return (
    <PreviewFrame browser={runtime.browser} height={collapsed ? PAGE_HEADER_HEIGHT : PREVIEW_SIZE.height}>
      <div className={`page-window${collapsed ? ' page-window--collapsed' : ''}`} {...(page?.color && { 'data-page-color': page.color })}>
        <header className="page-window-head" style={{ height: PAGE_HEADER_HEIGHT }}>
          <span className="page-window-title" title={title}>
            {title}
          </span>
          <button
            type="button"
            className="page-window-btn"
            title={collapsed ? 'Open it up again' : 'Shrink to the title'}
            aria-label={collapsed ? 'Open it up again' : 'Shrink to the title'}
            aria-expanded={!collapsed}
            onClick={() => collapse(!collapsed)}
          >
            —
          </button>
          <button type="button" className="page-window-btn" title="Back in the Pad (the page stays)" aria-label="Back in the Pad" onClick={() => void unpop()}>
            ×
          </button>
        </header>
        {/* Kept mounted while collapsed, so nothing typed is dropped; just not shown. */}
        <div className="page-window-body" hidden={collapsed}>
          {error && <p className="card-error">{error}</p>}
          {gone && <p className="page-window-gone">This page isn't on the Pad any more.</p>}
          {initial && !gone && <PageEditor key={initial.id} api={api} page={initial} compact />}
        </div>
        {!collapsed && <ResizeGrip shell={shell} />}
      </div>
    </PreviewFrame>
  );
}

/** The bottom-right corner: drag it to resize the window (main follows the cursor). */
function ResizeGrip({ shell }: { shell: PageWindowShell }) {
  const held = useRef(false);
  const end = () => {
    if (!held.current) return;
    held.current = false;
    shell.resizeEnd();
  };
  return (
    <div
      className="page-window-grip"
      title="Drag to resize"
      aria-hidden
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        held.current = true;
        shell.resizeStart();
      }}
      onPointerMove={() => held.current && shell.resizeMove()}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
    />
  );
}

/** Plain-browser preview only: a pretend desktop with the window-sized frame top right, like a new page window. */
function PreviewFrame({ browser, height, children }: { browser: boolean; height: number; children: ReactNode }) {
  useEffect(() => {
    if (!browser) return;
    document.body.classList.add('mock-desk');
    return () => document.body.classList.remove('mock-desk');
  }, [browser]);
  if (!browser) return <>{children}</>;
  return <div style={{ position: 'fixed', top: 24, right: 24, width: PREVIEW_SIZE.width, height }}>{children}</div>;
}
