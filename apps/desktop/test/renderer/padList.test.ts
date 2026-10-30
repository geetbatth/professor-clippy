import { describe, expect, it } from 'vitest';
import type { Page } from '@clippy/shared/schemas';
import { applyPage, authorBadge, firstLine, padSections, pageMeta, removePage, searchPages, sortPages } from '../../src/renderer/src/note/padList';

const MIN = 60_000;
const NOW = new Date(2026, 9, 30, 12, 0).getTime();
let n = 0;

function page(patch: Partial<Page> = {}): Page {
  n += 1;
  return {
    id: `01JBX00000000000000000000${n}`,
    title: `Page ${n}`,
    body: '',
    color: null,
    pinned: false,
    popped: false,
    popBounds: null,
    author: 'you',
    project: null,
    unseen: false,
    createdAt: NOW - 60 * MIN,
    updatedAt: NOW - 60 * MIN,
    archivedAt: null,
    ...patch,
  };
}

describe('padSections', () => {
  it('splits pinned from recent and keeps the order it was given', () => {
    const a = page({ pinned: true });
    const b = page();
    const c = page({ pinned: true });
    const d = page();
    expect(padSections([b, a, d, c])).toEqual({ pinned: [a, c], recent: [b, d] });
    expect(padSections([])).toEqual({ pinned: [], recent: [] });
  });
});

describe('sortPages', () => {
  it('puts pinned first, then the most recently changed, like listPages', () => {
    const old = page({ updatedAt: NOW - 50 * MIN });
    const fresh = page({ updatedAt: NOW - MIN });
    const pinnedOld = page({ pinned: true, updatedAt: NOW - 90 * MIN });
    expect(sortPages([old, fresh, pinnedOld])).toEqual([pinnedOld, fresh, old]);
  });
});

describe('applyPage / removePage', () => {
  it('keeps the lists live from page:changed: new pages in, archived ones moved, restored ones back, in list order', () => {
    const a = page({ updatedAt: NOW - 30 * MIN });
    const b = page({ updatedAt: NOW - 20 * MIN });
    let lists = { pages: [b, a], archived: [] as Page[] };
    const c = page({ updatedAt: NOW - MIN });
    lists = applyPage(lists, c);
    expect(lists.pages).toEqual([c, b, a]);
    const aEdited = { ...a, body: 'new', updatedAt: NOW };
    lists = applyPage(lists, aEdited);
    expect(lists.pages).toEqual([aEdited, c, b]);
    const bArchived = { ...b, archivedAt: NOW };
    lists = applyPage(lists, bArchived);
    expect(lists).toEqual({ pages: [aEdited, c], archived: [bArchived] });
    const bBack = { ...bArchived, archivedAt: null, updatedAt: NOW + 1 };
    lists = applyPage(lists, bBack);
    expect(lists).toEqual({ pages: [bBack, aEdited, c], archived: [] });
    expect(removePage(lists, c.id)).toEqual({ pages: [bBack, aEdited], archived: [] });
  });
});

describe('searchPages', () => {
  it('matches part of the title or the text, in any case; an empty box matches all', () => {
    const dave = page({ title: 'Call Dave', body: 'about the invoice' });
    const deploy = page({ title: 'Deploy steps', body: '1. Tag the release' });
    expect(searchPages([dave, deploy], 'INVOICE')).toEqual([dave]);
    expect(searchPages([dave, deploy], 'deploy')).toEqual([deploy]);
    expect(searchPages([dave, deploy], '  ')).toEqual([dave, deploy]);
  });
});

describe('authorBadge', () => {
  it('shows nothing for your pages, a paperclip for Clippy and a robot with the project for agents', () => {
    expect(authorBadge(page())).toBeUndefined();
    expect(authorBadge(page({ author: 'clippy-brain' }))).toBe('📎 Clippy');
    expect(authorBadge(page({ author: 'claude-code', project: 'payments-api' }))).toBe('🤖 claude-code · payments-api');
    expect(authorBadge(page({ author: 'claude-code' }))).toBe('🤖 claude-code');
  });
});

describe('firstLine', () => {
  it('is the first line with text in it', () => {
    expect(firstLine('\n\n  milk\neggs')).toBe('milk');
    expect(firstLine('')).toBe('');
  });
});

describe('pageMeta', () => {
  it('says who made a page nobody has changed since, else when it was last edited', () => {
    expect(pageMeta(page({ updatedAt: NOW - 4 * MIN }), NOW)).toBe('edited 4 min ago');
    expect(pageMeta(page({ author: 'clippy-brain', createdAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN }), NOW)).toBe('made by Clippy · 10 min ago');
    expect(pageMeta(page({ author: 'claude-code', createdAt: NOW - 10 * MIN, updatedAt: NOW - 10 * MIN }), NOW)).toBe('made by claude-code · 10 min ago');
    expect(pageMeta(page({ author: 'clippy-brain', createdAt: NOW - 10 * MIN, updatedAt: NOW - 2 * MIN }), NOW)).toBe('edited 2 min ago');
  });
});
