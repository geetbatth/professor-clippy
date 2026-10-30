import type { AnsweredVia, Message, OnboardingState, Page, StandingOrder } from '@clippy/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { BRIEF_TITLE } from '../src/main/brief';
import { Bus } from '../src/main/core/bus';
import { Onboarding, ONBOARDING_KV } from '../src/main/onboarding';
import { FakeClock } from './core/fakeClock';

const T0 = Date.UTC(2026, 9, 30, 9);
const ID = '01JB2Z3K4M5N6P7Q8R9S0T1V2A';

/** The store's kv table, and nothing else. */
class FakeKv {
  readonly map = new Map<string, string>();
  getKv(key: string) {
    return this.map.get(key);
  }
  setKv(key: string, value: string) {
    this.map.set(key, value);
  }
}

const message = (over: Partial<Message> = {}): Message => ({
  id: ID,
  kind: 'note',
  body: 'x',
  sender: 'claude-code',
  urgent: false,
  state: 'unread',
  createdAt: T0,
  ...over,
});
const answered = (via: AnsweredVia) => {
  const m = message({ kind: 'ask', answer: 'Tea', answeredVia: via, state: 'done' });
  return { message: m, result: { id: m.id, status: 'answered' as const, answer: 'Tea', answeredVia: via } };
};
const page = (over: Partial<Page> = {}): Page => ({
  id: ID,
  title: 'Scratch',
  body: '',
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
  ...over,
});

describe('Onboarding', () => {
  let bus: Bus;
  let kv: FakeKv;
  let clock: FakeClock;
  let onboarding: Onboarding;
  let changes: OnboardingState[];

  beforeEach(() => {
    bus = new Bus();
    kv = new FakeKv();
    clock = new FakeClock(T0);
    changes = [];
    bus.on('onboarding:changed', (s) => changes.push(s));
    onboarding = new Onboarding({ bus, store: kv, clock });
    onboarding.start();
  });

  it('starts the clock the first time it runs, and keeps it after a restart', () => {
    expect(onboarding.state()).toEqual({ startedAt: T0, done: [], dismissed: false, tipsShown: [] });
    expect(JSON.parse(kv.map.get(ONBOARDING_KV)!)).toEqual({ startedAt: T0, done: [], dismissed: false, tipsShown: [] });
    onboarding.stop();
    clock.advance(5 * 24 * 60 * 60_000);
    const again = new Onboarding({ bus, store: kv, clock });
    again.start();
    expect(again.state().startedAt).toBe(T0);
  });

  it('answering an ask via the desk (or a phone) marks "answer"; via Clippy does not', () => {
    bus.emit('ask:answered', answered('clippy'));
    expect(onboarding.state().done).toEqual([]);
    expect(changes).toEqual([]);
    bus.emit('ask:answered', answered('desk'));
    expect(onboarding.state().done).toEqual(['answer']);
    expect(changes.at(-1)?.done).toEqual(['answer']);
    // Persisted.
    expect(JSON.parse(kv.map.get(ONBOARDING_KV)!).done).toEqual(['answer']);
  });

  it('a snooze marks "snooze"; other updates do not', () => {
    bus.emit('message:updated', message({ state: 'done' }));
    expect(onboarding.state().done).toEqual([]);
    bus.emit('message:updated', message({ state: 'snoozed', snoozedUntil: T0 + 60_000 }));
    expect(onboarding.state().done).toEqual(['snooze']);
  });

  it('an order added, a page popped out and a morning brief mark theirs', () => {
    const order: StandingOrder = { id: ID, text: 'When asked, say yes', active: true, createdAt: T0 };
    bus.emit('order:added', order);
    bus.emit('page:changed', page());
    bus.emit('page:changed', page({ popped: true }));
    bus.emit('message:new', message({ sender: 'claude-code', title: BRIEF_TITLE }));
    expect(onboarding.state().done).toEqual(['order', 'popout']);
    bus.emit('message:new', message({ sender: 'clippy', title: BRIEF_TITLE }));
    expect(onboarding.state().done).toEqual(['order', 'popout', 'brief']);
  });

  it('marks an item once, and only reports real changes', () => {
    onboarding.mark('hotkey');
    onboarding.mark('hotkey');
    expect(onboarding.state().done).toEqual(['hotkey']);
    expect(changes).toHaveLength(1);
  });

  it('stops listening when stopped', () => {
    onboarding.stop();
    bus.emit('ask:answered', answered('desk'));
    expect(onboarding.state().done).toEqual([]);
  });

  it('restartWelcome keeps the done items and clears dismissed', () => {
    onboarding.mark('connect');
    onboarding.mark('snooze');
    onboarding.dismiss();
    expect(onboarding.state().dismissed).toBe(true);
    const state = onboarding.restartWelcome();
    expect(state).toMatchObject({ startedAt: T0, done: ['connect', 'snooze'], dismissed: false });
    expect(onboarding.state()).toEqual(state);
  });

  it('records a tip as shown, with when', () => {
    clock.advance(60_000);
    onboarding.tipShown('pad-jot');
    onboarding.tipShown('pad-jot');
    expect(onboarding.state()).toMatchObject({ tipsShown: ['pad-jot'], lastTipAt: T0 + 60_000 });
  });

  it('starts afresh from a damaged record', () => {
    kv.setKv(ONBOARDING_KV, '{"startedAt":"soon"');
    const again = new Onboarding({ bus, store: kv, clock });
    again.start();
    expect(again.state()).toEqual({ startedAt: T0, done: [], dismissed: false, tipsShown: [] });
  });
});
