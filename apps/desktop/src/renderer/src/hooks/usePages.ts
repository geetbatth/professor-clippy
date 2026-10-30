import { useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import { applyPage, removePage, type PadLists } from '../note/padList';

export interface PadPages extends PadLists {
  /** Loaded at least once. */
  loaded: boolean;
  /** Some page on the Pad was written by someone else and not opened since (the tab's dot). */
  unseen: boolean;
}

/** The Pad's pages and the archived ones, kept live from `page:changed` / `page:deleted`. */
export function usePages(api: ClippyWindowApi): PadPages {
  const [lists, setLists] = useState<PadLists>({ pages: [], archived: [] });
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([api.listPages({}), api.listPages({ archived: true })]).then(([pages, archived]) => {
      if (!live) return;
      setLists({ pages, archived });
      setLoaded(true);
    });
    const offChanged = api.on('page:changed', (page) => setLists((l) => applyPage(l, page)));
    const offDeleted = api.on('page:deleted', ({ id }) => setLists((l) => removePage(l, id)));
    return () => {
      live = false;
      offChanged();
      offDeleted();
    };
  }, [api]);

  return { ...lists, loaded, unseen: lists.pages.some((p) => p.unseen) };
}
