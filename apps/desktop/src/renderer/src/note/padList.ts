/** The Pad's list: its sections, search and what each row says. Pure, unit-tested. */
import { BRAIN_SENDER } from '@clippy/shared/brain';
import { PAGE_USER_AUTHOR, type Page } from '@clippy/shared/schemas';
import { timeAgo } from './timeAgo';

/** Split into the pinned and the rest, each in the order given (`listPages` order). */
export function padSections(pages: readonly Page[]): { pinned: Page[]; recent: Page[] } {
  return { pinned: pages.filter((p) => p.pinned), recent: pages.filter((p) => !p.pinned) };
}

/** Pinned first, then the most recently changed (the order `listPages` returns). */
export function sortPages(pages: readonly Page[]): Page[] {
  return [...pages].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
}

/** The Pad's pages and the archived ones, each in `listPages` order. */
export interface PadLists {
  pages: Page[];
  archived: Page[];
}

/** The lists with `page` (from `page:changed`) in its place: in the Pad, or archived. */
export function applyPage(lists: PadLists, page: Page): PadLists {
  const rest = removePage(lists, page.id);
  return page.archivedAt === null
    ? { pages: sortPages([...rest.pages, page]), archived: rest.archived }
    : { pages: rest.pages, archived: sortPages([...rest.archived, page]) };
}

/** The lists without the page (`page:deleted`). */
export function removePage(lists: PadLists, id: string): PadLists {
  return { pages: lists.pages.filter((p) => p.id !== id), archived: lists.archived.filter((p) => p.id !== id) };
}

/** The pages whose title or text contains `q` (any case); all of them for an empty box. */
export function searchPages(pages: readonly Page[], q: string): Page[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...pages];
  return pages.filter((p) => `${p.title}\n${p.body}`.toLowerCase().includes(needle));
}

/** Who wrote it, for pages you did not: "Clippy" or the agent's sender name. */
function authorName(page: Page): string {
  return page.author === BRAIN_SENDER ? 'Clippy' : page.author;
}

/** "📎 Clippy" for Clippy's pages, "🤖 claude-code · payments-api" for an agent's; none for yours. */
export function authorBadge(page: Page): string | undefined {
  if (page.author === PAGE_USER_AUTHOR) return undefined;
  if (page.author === BRAIN_SENDER) return '📎 Clippy';
  return page.project ? `🤖 ${page.author} · ${page.project}` : `🤖 ${page.author}`;
}

/** The first line with something on it. */
export function firstLine(body: string): string {
  return body.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

/** "made by Clippy · 10 min ago" while nobody has touched someone else's page, else "edited 4 min ago". */
export function pageMeta(page: Page, now: number): string {
  if (page.author !== PAGE_USER_AUTHOR && page.updatedAt === page.createdAt) return `made by ${authorName(page)} · ${timeAgo(page.createdAt, now)}`;
  return `edited ${timeAgo(page.updatedAt, now)}`;
}
