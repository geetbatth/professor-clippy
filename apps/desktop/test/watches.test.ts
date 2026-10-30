import type { Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Bus } from '../src/main/core/bus';
import { Store } from '../src/main/core/store';
import { matchWatches, Watcher } from '../src/main/watches';
import { FakeClock } from './core/fakeClock';

const T0 = Date.UTC(2026, 9, 30, 9);
const ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2A';

type Trigger = Pick<Message, 'kind' | 'project' | 'event' | 'sender'>;

const watch = (over: Partial<Parameters<typeof matchWatches>[0][number]> = {}) => ({
  id: ID,
  event: 'finished' as const,
  nudge: 'Deploy',
  active: true,
  createdAt: 1,
  ...over,
});
/** A note from the hook's Stop event, in project professor-clippy (fields can be removed by passing undefined-free overrides). */
const msg = (over: Partial<Trigger> = {}): Trigger => ({
  kind: 'note',
  sender: 'claude-code',
  project: 'professor-clippy',
  event: 'agent-finished',
  ...over,
});
const without = (m: Trigger, key: 'project' | 'event'): Trigger => {
  const { [key]: _dropped, ...rest } = m;
  return rest;
};

describe('matchWatches', () => {
  it('matches the project as a case-insensitive substring, and any project when the watch names none', () => {
    expect(matchWatches([watch({ project: 'Clippy' })], msg())).toHaveLength(1);
    expect(matchWatches([watch({ project: 'payments' })], msg())).toEqual([]);
    expect(matchWatches([watch()], msg({ project: 'whatever' }))).toHaveLength(1);
    // A watch that names a project cannot match a message with none.
    const noProject = without(msg(), 'project');
    expect(matchWatches([watch({ project: 'clippy' })], noProject)).toEqual([]);
    expect(matchWatches([watch()], noProject)).toHaveLength(1);
  });

  it('finished matches only an agent-finished note', () => {
    const finished = [watch({ event: 'finished' })];
    expect(matchWatches(finished, msg({ event: 'agent-needs-permission' }))).toEqual([]);
    expect(matchWatches(finished, without(msg(), 'event'))).toEqual([]);
    expect(matchWatches(finished, { ...without(msg(), 'event'), kind: 'ask' })).toEqual([]);
    expect(matchWatches(finished, msg())).toHaveLength(1);
  });

  it('any matches any note or ask, but not a reminder or a chat line', () => {
    const plain = without(msg(), 'event');
    const any = [watch({ event: 'any', project: 'clippy' })];
    expect(matchWatches(any, plain)).toHaveLength(1);
    expect(matchWatches(any, msg({ event: 'agent-needs-permission' }))).toHaveLength(1);
    expect(matchWatches(any, { ...plain, kind: 'ask' })).toHaveLength(1);
    expect(matchWatches(any, { ...plain, kind: 'reminder' })).toEqual([]);
    expect(matchWatches(any, { ...plain, kind: 'chat' })).toEqual([]);
  });

  it("never matches Clippy's own notes", () => {
    expect(matchWatches([watch({ event: 'any' }), watch({ event: 'finished' })], msg({ sender: 'clippy' }))).toEqual([]);
  });

  it('returns every watch that matches', () => {
    const a = watch({ id: 'a', project: 'clippy' });
    const b = watch({ id: 'b', project: 'payments' });
    const c = watch({ id: 'c' });
    expect(matchWatches([a, b, c], msg()).map((w) => w.id)).toEqual(['a', 'c']);
  });
});

describe('Watcher', () => {
  let clock: FakeClock;
  let bus: Bus;
  let store: Store;
  let watcher: Watcher;

  beforeEach(() => {
    clock = new FakeClock(T0);
    bus = new Bus();
    store = new Store({ path: ':memory:', bus, clock });
    watcher = new Watcher({ bus, store, clock });
    watcher.start();
  });
  afterEach(() => {
    watcher.stop();
    store.close();
  });

  const finished = (extra: Partial<Parameters<Store['createMessage']>[0]> = {}) =>
    store.createMessage({
      kind: 'note',
      body: '✅ professor-clippy agent finished',
      sender: 'claude-code',
      project: 'professor-clippy',
      event: 'agent-finished',
      ...extra,
    });
  const nudges = () => store.listMessages({}).filter((m) => m.sender === 'clippy');

  it('fires once when a matching agent finishes, then retires the watch', () => {
    const w = store.insertWatch({ project: 'Clippy', event: 'finished', nudge: 'Deploy to staging' });
    clock.advance(5_000);
    finished();
    expect(nudges()).toEqual([
      expect.objectContaining({ kind: 'note', sender: 'clippy', title: '⏰ Nudge', body: 'Deploy to staging\n(professor-clippy agent finished)', state: 'unread' }),
    ]);
    expect(store.listActiveWatches()).toEqual([]);
    expect(store.cancelWatch(w.id)).toMatchObject({ active: false, firedAt: T0 + 5_000 });

    finished();
    expect(nudges()).toHaveLength(1); // a second finish creates nothing
  });

  it('fires for a finished note the away-only rule stored as done', () => {
    store.insertWatch({ project: 'clippy', event: 'finished', nudge: 'Check it' });
    finished({ state: 'done', quietIfActive: true });
    expect(nudges()).toHaveLength(1);
    expect(nudges()[0]).toMatchObject({ state: 'unread' });
  });

  it('ignores other projects, other events, and its own nudge', () => {
    store.insertWatch({ project: 'payments', event: 'finished', nudge: 'Deploy' });
    store.insertWatch({ project: 'clippy', event: 'finished', nudge: 'Review' });
    finished({ project: 'billing' });
    store.createMessage({ kind: 'note', body: 'permission', sender: 'claude-code', project: 'professor-clippy', event: 'agent-needs-permission', urgent: true });
    store.createMessage({ kind: 'reminder', body: 'clippy', sender: 'someone', project: 'professor-clippy' });
    expect(nudges()).toEqual([]);
    expect(store.listActiveWatches()).toHaveLength(2);
  });

  it('an any-watch fires on a question, and says what happened', () => {
    store.insertWatch({ project: 'clippy', event: 'any', nudge: 'Be ready' });
    store.createMessage({ kind: 'ask', body: 'Which branch?', sender: 'claude-code', project: 'professor-clippy' });
    expect(nudges().map((m) => m.body)).toEqual(['Be ready\n(professor-clippy agent asked a question)']);
  });

  it('fires every matching watch, and a no-project watch for a note with no project', () => {
    store.insertWatch({ project: 'clippy', event: 'finished', nudge: 'One' });
    store.insertWatch({ event: 'finished', nudge: 'Two' });
    store.createMessage({ kind: 'note', body: 'done', sender: 'codex', event: 'agent-finished' });
    expect(nudges().map((m) => m.body)).toEqual(['Two\n(an agent finished)']);
    expect(store.listActiveWatches().map((w) => w.nudge)).toEqual(['One']);
  });

  it('does not fire a cancelled watch, and stop() unsubscribes', () => {
    const w = store.insertWatch({ event: 'finished', nudge: 'Never' });
    store.cancelWatch(w.id);
    finished();
    expect(nudges()).toEqual([]);

    store.insertWatch({ event: 'finished', nudge: 'Later' });
    watcher.stop();
    finished();
    expect(nudges()).toEqual([]);
    watcher.start();
    watcher.start(); // starting twice must not double-subscribe
    finished();
    expect(nudges()).toHaveLength(1);
  });
});
