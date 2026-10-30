/**
 * The Pad's pages: the user's own notes, which Clippy's brain and agents can write too.
 *
 * - The user writes as {@link PAGE_USER_AUTHOR} (`'you'`, through IPC only); the API and the MCP
 *   server write as their sender. The user and Clippy's brain may change any page; any other
 *   sender only the pages it wrote ({@link ForbiddenError}, 403).
 * - A change with a `baseUpdatedAt` that is not the page's current `updatedAt` is refused with a
 *   {@link ConflictError} carrying the page as it is now, so a save made while someone else
 *   changed the page never silently overwrites them (the editor offers "Keep mine" / "Use theirs").
 *   `updatedAt` strictly increases on every change, so two changes in the same millisecond still
 *   look different.
 * - A change by anyone but the user marks the page `unseen` until the user opens it.
 * - Every change emits `page:changed` (the page as it is now) and a delete `page:deleted`.
 */
import {
  BRAIN_SENDER,
  NewPageInput,
  PAGE_BODY_MAX,
  PAGE_USER_AUTHOR,
  PageChange,
  appendToBody,
  findPageByTitle,
  type Page,
  type PageBounds,
  type PageFilter,
} from '@clippy/shared';
import { z } from 'zod';
import type { Bus } from './bus';
import { systemClock, type Clock } from './clock';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from './errors';
import type { PagePatch, Store } from './store';

/** A page nobody has changed for this long is archived (unless pinned or popped out). */
export const PAGE_ARCHIVE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
/** How often {@link startStaleArchiver} looks for old pages. */
export const PAGE_ARCHIVE_EVERY_MS = 6 * 60 * 60 * 1000;

export const ONLY_AUTHOR_MESSAGE = 'Only the person who wrote this page (or you) can change it.';
export const PAGE_CONFLICT_MESSAGE = 'This page changed since you last saw it.';

export interface PagesOptions {
  store: Store;
  bus: Bus;
  clock?: Clock;
}

export class Pages {
  readonly #store: Store;
  readonly #bus: Bus;
  readonly #clock: Clock;

  constructor(options: PagesOptions) {
    this.#store = options.store;
    this.#bus = options.bus;
    this.#clock = options.clock ?? systemClock;
  }

  /** Pages, pinned first, then most recently changed; not archived unless `archived`. */
  list(filter: PageFilter = {}): Page[] {
    return this.#store.listPages(filter);
  }

  /** Throws NotFoundError for an unknown id. */
  get(id: string): Page {
    const page = this.#store.getPage(id);
    if (!page) throw new NotFoundError(`No page ${id}`);
    return page;
  }

  /** The page (not archived) a title refers to; see `findPageByTitle`. */
  findByTitle(title: string): Page | undefined {
    return findPageByTitle(this.list(), title);
  }

  /** A new page by `author`; unseen unless the user wrote it. */
  create(input: NewPageInput, author: string): Page {
    const { title, body, color, project } = parse(NewPageInput, input);
    const now = this.#clock.now();
    const page: Page = {
      id: this.#store.newId(),
      title,
      body: body ?? '',
      color: color ?? null,
      pinned: false,
      popped: false,
      popBounds: null,
      author,
      project: project ?? null,
      unseen: author !== PAGE_USER_AUTHOR,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    };
    this.#store.insertPage(page);
    return this.#changed(page);
  }

  /**
   * Change a page's title, body (replace it, or `append` a line), colour or pin. Throws
   * NotFoundError, ForbiddenError (an agent changing a page it did not write), ConflictError
   * (`baseUpdatedAt` is stale; `details.page` is the page as it is now) or ValidationError.
   * A change that would alter nothing is not stored and emits nothing.
   */
  write(id: string, change: PageChange, author: string): Page {
    const { title, body, append, color, pinned, baseUpdatedAt } = parse(PageChange, change);
    const page = this.get(id);
    this.#checkAuthor(page, author);
    if (baseUpdatedAt !== undefined && baseUpdatedAt !== page.updatedAt) {
      throw new ConflictError(PAGE_CONFLICT_MESSAGE, { page });
    }
    if (body !== undefined && append !== undefined) throw new ValidationError('Give either body or append, not both');
    const nextBody = append !== undefined ? appendToBody(page.body, append) : (body ?? page.body);
    if (nextBody.length > PAGE_BODY_MAX) throw new ValidationError(`A page holds at most ${PAGE_BODY_MAX} characters`);
    const patch: PagePatch = {
      title: title ?? page.title,
      body: nextBody,
      color: color === undefined ? page.color : color,
      pinned: pinned ?? page.pinned,
    };
    if (patch.title === page.title && patch.body === page.body && patch.color === page.color && patch.pinned === page.pinned) {
      return page;
    }
    return this.#update(id, {
      ...patch,
      updatedAt: Math.max(this.#clock.now(), page.updatedAt + 1),
      unseen: author !== PAGE_USER_AUTHOR,
    });
  }

  /** The user opened the page. */
  markSeen(id: string): Page {
    const page = this.get(id);
    return page.unseen ? this.#update(id, { unseen: false }) : page;
  }

  /**
   * Open the page as its own window (or not). `bounds` replaces the saved window position when given.
   * Not a change to the page: `updatedAt` stays. An archived page is refused (ConflictError), so it
   * never opens a window.
   */
  setPopped(id: string, popped: boolean, bounds?: PageBounds): Page {
    const page = this.get(id);
    if (popped && page.archivedAt !== null) throw new ConflictError('Restore the page before pinning it out.');
    return this.#update(id, { popped, ...(bounds && { popBounds: bounds }) });
  }

  /** Archive a page (it leaves the list and its window closes). An agent may archive only its own pages. */
  archive(id: string, author: string = PAGE_USER_AUTHOR): Page {
    const page = this.get(id);
    this.#checkAuthor(page, author);
    if (page.archivedAt !== null) return page;
    return this.#update(id, { archivedAt: this.#clock.now(), popped: false });
  }

  /** Bring an archived page back. It counts as just changed, so it is not archived again for being old. */
  restore(id: string): Page {
    const page = this.get(id);
    if (page.archivedAt === null) return page;
    return this.#update(id, { archivedAt: null, updatedAt: Math.max(this.#clock.now(), page.updatedAt + 1) });
  }

  /** Delete an archived page for good (the user only: IPC, no route). */
  remove(id: string): void {
    const page = this.get(id);
    if (page.archivedAt === null) throw new ConflictError('Archive the page before deleting it.');
    this.#store.deletePage(id);
    this.#bus.emit('page:deleted', { id });
  }

  /** Archive every page not pinned, popped or archived that nobody changed for {@link PAGE_ARCHIVE_AFTER_MS}. Returns how many. */
  archiveStale(now: number): number {
    const stale = this.#store.listStalePages(now - PAGE_ARCHIVE_AFTER_MS);
    for (const page of stale) this.#update(page.id, { archivedAt: now });
    return stale.length;
  }

  #checkAuthor(page: Page, author: string): void {
    if (author === PAGE_USER_AUTHOR || author === BRAIN_SENDER || author === page.author) return;
    throw new ForbiddenError(ONLY_AUTHOR_MESSAGE);
  }

  #update(id: string, patch: PagePatch): Page {
    return this.#changed(this.#store.updatePage(id, patch)!);
  }

  #changed(page: Page): Page {
    this.#bus.emit('page:changed', page);
    return page;
  }
}

/**
 * Archive old pages now and every {@link PAGE_ARCHIVE_EVERY_MS} (started by `startServices`).
 * Returns the stop function.
 */
export function startStaleArchiver(pages: Pages, clock: Clock = systemClock, log: (err: unknown) => void = defaultLog): () => void {
  let timer: unknown;
  let stopped = false;
  const run = () => {
    try {
      pages.archiveStale(clock.now());
    } catch (err) {
      log(err);
    }
    if (!stopped) timer = clock.setTimeout(run, PAGE_ARCHIVE_EVERY_MS);
  };
  run();
  return () => {
    stopped = true;
    if (timer !== undefined) clock.clearTimeout(timer);
  };
}

function defaultLog(err: unknown): void {
  console.error('[clippy] archiving old pages failed:', err);
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(z.prettifyError(result.error));
  return result.data;
}
