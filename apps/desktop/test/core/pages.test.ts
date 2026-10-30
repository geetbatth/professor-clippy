import { BRAIN_SENDER, Page, PAGE_USER_AUTHOR, appendToBody, findPageByTitle } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus, type CoreEventMap } from '../../src/main/core/bus';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../src/main/core/errors';
import {
  ONLY_AUTHOR_MESSAGE,
  PAGE_ARCHIVE_AFTER_MS,
  PAGE_ARCHIVE_EVERY_MS,
  Pages,
  startStaleArchiver,
} from '../../src/main/core/pages';
import { Store } from '../../src/main/core/store';
import { FakeClock } from './fakeClock';

const T0 = Date.UTC(2026, 9, 30, 16);
const DAY = 24 * 60 * 60 * 1000;
const YOU = PAGE_USER_AUTHOR;

describe('Pages', () => {
  let clock: FakeClock;
  let bus: Bus;
  let store: Store;
  let pages: Pages;
  let events: { event: keyof CoreEventMap; payload: unknown }[];

  beforeEach(() => {
    clock = new FakeClock(T0);
    bus = new Bus();
    store = new Store({ path: ':memory:', bus, clock });
    pages = new Pages({ store, bus, clock });
    events = [];
    bus.on('page:changed', (payload) => events.push({ event: 'page:changed', payload }));
    bus.on('page:deleted', (payload) => events.push({ event: 'page:deleted', payload }));
  });
  afterEach(() => store.close());

  describe('create', () => {
    it("by you is seen, by an agent unseen, and both parse as a Page and emit page:changed", () => {
      const mine = pages.create({ title: 'Scratch', body: 'hello' }, YOU);
      expect(mine).toEqual({
        id: expect.any(String),
        title: 'Scratch',
        body: 'hello',
        color: null,
        pinned: false,
        popped: false,
        popBounds: null,
        author: 'you',
        project: null,
        unseen: false,
        createdAt: T0,
        updatedAt: T0,
        archivedAt: null,
      });
      expect(Page.parse(mine)).toEqual(mine);
      const theirs = pages.create({ title: 'Deploy steps', color: 'mint', project: 'payments' }, 'claude-code');
      expect(theirs).toMatchObject({ unseen: true, author: 'claude-code', project: 'payments', color: 'mint', body: '' });
      expect(events).toEqual([
        { event: 'page:changed', payload: mine },
        { event: 'page:changed', payload: theirs },
      ]);
      expect(pages.get(theirs.id)).toEqual(theirs);
    });

    it('rejects a missing or overlong title and a body over 100 000 characters', () => {
      expect(() => pages.create({ title: '' }, YOU)).toThrow(ValidationError);
      expect(() => pages.create({ title: 'x'.repeat(121) }, YOU)).toThrow(ValidationError);
      expect(() => pages.create({ title: 'Big', body: 'x'.repeat(100_001) }, YOU)).toThrow(ValidationError);
      expect(pages.create({ title: 'x'.repeat(120), body: 'x'.repeat(100_000) }, YOU).body).toHaveLength(100_000);
    });
  });

  describe('list', () => {
    it('puts pinned pages first, then the most recently changed, and hides archived ones unless asked', () => {
      const a = pages.create({ title: 'A' }, YOU);
      clock.advance(1000);
      const b = pages.create({ title: 'B' }, YOU);
      clock.advance(1000);
      const c = pages.create({ title: 'C' }, YOU);
      clock.advance(1000);
      pages.write(a.id, { pinned: true }, YOU);
      clock.advance(1000);
      pages.write(b.id, { body: 'edited' }, YOU);
      expect(pages.list({}).map((p) => p.title)).toEqual(['A', 'B', 'C']);
      pages.archive(b.id);
      expect(pages.list().map((p) => p.title)).toEqual(['A', 'C']);
      expect(pages.list({ archived: true }).map((p) => p.title)).toEqual(['B']);
      expect(c.archivedAt).toBeNull();
    });

    it('searches title and body case-insensitively, and % and _ only match themselves', () => {
      pages.create({ title: 'Budget', body: 'We are 50% done' }, YOU);
      pages.create({ title: 'Other', body: 'We are 500 done' }, YOU);
      pages.create({ title: 'snake_case notes', body: '' }, YOU);
      pages.create({ title: 'snakeXcase', body: '' }, YOU);
      expect(pages.list({ q: '50%' }).map((p) => p.title)).toEqual(['Budget']);
      expect(pages.list({ q: 'BUDGET' }).map((p) => p.title)).toEqual(['Budget']);
      expect(pages.list({ q: 'e_c' }).map((p) => p.title)).toEqual(['snake_case notes']);
      expect(pages.list({ q: '' })).toHaveLength(4);
    });
  });

  describe('get and findByTitle', () => {
    it('get throws NotFoundError for an unknown id', () => {
      expect(() => pages.get('01JB2Z3K4M5N6P7Q8R9S0T1V2Z')).toThrow(NotFoundError);
    });

    it('matches a title exactly (any case) first, else a unique prefix; the newest exact match wins', () => {
      const shopping = pages.create({ title: 'Shopping list' }, YOU);
      clock.advance(1);
      const dave1 = pages.create({ title: 'Dave call' }, YOU);
      clock.advance(1);
      const dave2 = pages.create({ title: 'dave call' }, YOU);
      pages.create({ title: 'Deploy steps' }, YOU);
      pages.create({ title: 'Deploy notes' }, YOU);
      expect(pages.findByTitle('SHOPPING LIST')?.id).toBe(shopping.id);
      expect(pages.findByTitle('shop')?.id).toBe(shopping.id);
      expect(pages.findByTitle('Dave call')?.id).toBe(dave2.id);
      expect(dave1.id).not.toBe(dave2.id);
      expect(pages.findByTitle('Deploy')).toBeUndefined(); // two pages start with it
      expect(pages.findByTitle('nothing')).toBeUndefined();
      pages.archive(shopping.id);
      expect(pages.findByTitle('Shopping list')).toBeUndefined();
    });
  });

  describe('write', () => {
    it('appends on a new line, or straight onto an empty body or one ending in a newline', () => {
      const a = pages.create({ title: 'A', body: 'a' }, YOU);
      expect(pages.write(a.id, { append: 'b' }, YOU).body).toBe('a\nb');
      const empty = pages.create({ title: 'E' }, YOU);
      expect(pages.write(empty.id, { append: 'b' }, YOU).body).toBe('b');
      const nl = pages.create({ title: 'N', body: 'a\n' }, YOU);
      expect(pages.write(nl.id, { append: 'b' }, YOU).body).toBe('a\nb');
      expect(appendToBody('a', 'b')).toBe('a\nb');
      expect(appendToBody('', 'b')).toBe('b');
    });

    it('refuses a stale save with the current page and leaves the body as the other writer left it (Review Focus 1)', () => {
      const page = pages.create({ title: 'Scratch', body: 'v1' }, YOU);
      // Clippy changes the page while the user is typing on top of v1...
      const clippys = pages.write(page.id, { append: 'from Clippy' }, BRAIN_SENDER);
      // ...so the user's save, based on v1, is refused and carries Clippy's version.
      let error: unknown;
      try {
        pages.write(page.id, { body: 'v1 plus my typing', baseUpdatedAt: page.updatedAt }, YOU);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(ConflictError);
      expect((error as ConflictError).details).toEqual({ page: clippys });
      expect(pages.get(page.id).body).toBe('v1\nfrom Clippy');
      // Saving again on top of the current version ("keep mine") works.
      expect(pages.write(page.id, { body: 'v1 plus my typing', baseUpdatedAt: clippys.updatedAt }, YOU).body).toBe('v1 plus my typing');
    });

    it('moves updatedAt forward on every change, even within the same millisecond', () => {
      const page = pages.create({ title: 'Fast' }, YOU);
      const one = pages.write(page.id, { body: '1' }, YOU);
      const two = pages.write(page.id, { body: '2' }, BRAIN_SENDER);
      expect(one.updatedAt).toBeGreaterThan(page.updatedAt);
      expect(two.updatedAt).toBeGreaterThan(one.updatedAt);
      expect(() => pages.write(page.id, { body: '3', baseUpdatedAt: one.updatedAt }, YOU)).toThrow(ConflictError);
    });

    it("lets an agent change only its own pages, and Clippy's brain and you change any (Review Focus 4)", () => {
      const mine = pages.create({ title: 'Mine', body: 'my text' }, YOU);
      const codex = pages.create({ title: 'Codex page' }, 'codex');
      expect(() => pages.write(mine.id, { body: 'agent text' }, 'claude-code')).toThrow(ForbiddenError);
      expect(() => pages.write(mine.id, { append: 'more' }, 'claude-code')).toThrow(ONLY_AUTHOR_MESSAGE);
      expect(() => pages.write(codex.id, { append: 'x' }, 'claude-code')).toThrow(ForbiddenError);
      expect(() => pages.archive(mine.id, 'claude-code')).toThrow(ForbiddenError);
      expect(pages.get(mine.id).body).toBe('my text');

      const own = pages.create({ title: 'Checklist' }, 'claude-code');
      expect(pages.write(own.id, { append: '- [ ] tests' }, 'claude-code').body).toBe('- [ ] tests');
      expect(pages.write(mine.id, { append: 'from Clippy' }, BRAIN_SENDER).body).toBe('my text\nfrom Clippy');
      expect(pages.write(codex.id, { body: 'edited by you' }, YOU).body).toBe('edited by you');
      expect(pages.get(codex.id).author).toBe('codex'); // the author never changes
    });

    it('marks a page unseen when anyone but you changes it, and seen when you do', () => {
      const page = pages.create({ title: 'Scratch' }, YOU);
      expect(pages.write(page.id, { append: 'hi' }, BRAIN_SENDER).unseen).toBe(true);
      expect(pages.markSeen(page.id).unseen).toBe(false);
      expect(pages.write(page.id, { append: 'again' }, BRAIN_SENDER).unseen).toBe(true);
      expect(pages.write(page.id, { color: 'sky', pinned: true }, YOU)).toMatchObject({ unseen: false, color: 'sky', pinned: true });
      expect(pages.write(page.id, { color: null }, YOU).color).toBeNull();
    });

    it('rejects a body over 100 000 characters (also after an append), body with append, and an unknown page', () => {
      const page = pages.create({ title: 'Big', body: 'x'.repeat(99_999) }, YOU);
      expect(() => pages.write(page.id, { body: 'x'.repeat(100_001) }, YOU)).toThrow(ValidationError);
      expect(() => pages.write(page.id, { append: 'yy' }, YOU)).toThrow(ValidationError);
      expect(() => pages.write(page.id, { body: 'a', append: 'b' }, YOU)).toThrow(ValidationError);
      expect(() => pages.write(page.id, { title: '' }, YOU)).toThrow(ValidationError);
      expect(() => pages.write('01JB2Z3K4M5N6P7Q8R9S0T1V2Z', { body: 'a' }, YOU)).toThrow(NotFoundError);
      expect(pages.get(page.id).body).toHaveLength(99_999);
    });

    it('leaves a page untouched (no event, same updatedAt) when nothing would change', () => {
      const page = pages.create({ title: 'Same', body: 'b' }, YOU);
      events.length = 0;
      expect(pages.write(page.id, { title: 'Same', body: 'b' }, BRAIN_SENDER)).toEqual(page);
      expect(events).toEqual([]);
    });
  });

  describe('seen, popped, archive, restore, remove', () => {
    it('markSeen and setPopped do not touch updatedAt; setPopped keeps the bounds unless given', () => {
      const page = pages.create({ title: 'Float' }, 'claude-code');
      clock.advance(5000);
      expect(pages.markSeen(page.id)).toMatchObject({ unseen: false, updatedAt: T0 });
      const bounds = { x: 10, y: 20, width: 260, height: 220, displayId: 1 };
      expect(pages.setPopped(page.id, true, bounds)).toMatchObject({ popped: true, popBounds: bounds, updatedAt: T0 });
      expect(pages.setPopped(page.id, false)).toMatchObject({ popped: false, popBounds: bounds, updatedAt: T0 });
      expect(events.at(-1)).toEqual({ event: 'page:changed', payload: pages.get(page.id) });
    });

    it('an archived page cannot be popped out (no window opens), but un-popping it is harmless', () => {
      const page = pages.create({ title: 'Old' }, YOU);
      pages.archive(page.id);
      events = [];
      expect(() => pages.setPopped(page.id, true)).toThrow(ConflictError);
      expect(() => pages.setPopped(page.id, true, { x: 0, y: 0, width: 260, height: 220, displayId: 1 })).toThrow(/Restore the page/);
      expect(pages.get(page.id).popped).toBe(false);
      expect(events).toEqual([]);
      expect(pages.setPopped(page.id, false)).toMatchObject({ popped: false });
    });

    it('archive un-pops the page; restore brings it back as freshly changed; remove only takes archived pages', () => {
      const page = pages.create({ title: 'Old' }, YOU);
      pages.setPopped(page.id, true);
      clock.advance(1000);
      const archived = pages.archive(page.id);
      expect(archived).toMatchObject({ archivedAt: T0 + 1000, popped: false });
      clock.advance(1000);
      const restored = pages.restore(page.id);
      expect(restored).toMatchObject({ archivedAt: null, updatedAt: T0 + 2000 });

      expect(() => pages.remove(page.id)).toThrow(ConflictError);
      expect(pages.get(page.id).title).toBe('Old');
      pages.archive(page.id);
      pages.remove(page.id);
      expect(() => pages.get(page.id)).toThrow(NotFoundError);
      expect(events.at(-1)).toEqual({ event: 'page:deleted', payload: { id: page.id } });
    });

    it('archiveStale archives pages untouched for over 30 days, but not pinned, popped or newer ones', () => {
      const old = pages.create({ title: 'Old' }, YOU);
      const pinned = pages.create({ title: 'Pinned' }, YOU);
      pages.write(pinned.id, { pinned: true }, YOU);
      const popped = pages.create({ title: 'Popped' }, YOU);
      pages.setPopped(popped.id, true);
      clock.advance(2 * DAY);
      const recent = pages.create({ title: 'Recent' }, YOU); // 29 days old below
      const now = T0 + 31 * DAY;
      expect(PAGE_ARCHIVE_AFTER_MS).toBe(30 * DAY);
      clock.advanceTo(now);
      events.length = 0;
      expect(pages.archiveStale(now)).toBe(1);
      expect(pages.get(old.id).archivedAt).toBe(now);
      for (const kept of [pinned, popped, recent]) expect(pages.get(kept.id).archivedAt).toBeNull();
      expect(events).toEqual([{ event: 'page:changed', payload: pages.get(old.id) }]);
      expect(pages.archiveStale(now)).toBe(0);
    });
  });

  it('the stale-page archiver runs at once and then every 6 hours until stopped', () => {
    const page = pages.create({ title: 'Old' }, YOU);
    clock.advanceTo(T0 + 30 * DAY - 1000);
    const stop = startStaleArchiver(pages, clock);
    expect(pages.get(page.id).archivedAt).toBeNull();
    expect(PAGE_ARCHIVE_EVERY_MS).toBe(6 * 60 * 60 * 1000);
    clock.advance(PAGE_ARCHIVE_EVERY_MS);
    expect(pages.get(page.id).archivedAt).toBe(T0 + 30 * DAY - 1000 + PAGE_ARCHIVE_EVERY_MS);
    const other = pages.create({ title: 'Later' }, YOU);
    stop();
    clock.advance(31 * DAY);
    expect(pages.get(other.id).archivedAt).toBeNull();
    expect(clock.pending).toBe(0);
  });

  it('findPageByTitle (shared) is what findByTitle uses', () => {
    const page = pages.create({ title: 'Groceries' }, YOU);
    expect(findPageByTitle(pages.list(), ' groceries ')?.id).toBe(page.id);
  });
});
