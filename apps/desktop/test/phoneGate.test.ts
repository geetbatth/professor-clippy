import type { Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asks } from '../src/main/core/asks';
import { Bus } from '../src/main/core/bus';
import { Store } from '../src/main/core/store';
import { PhoneGate } from '../src/main/phoneGate';
import { FakeClock } from './core/fakeClock';

const T0 = Date.UTC(2026, 9, 30, 9);
const TICK = 30_000;

describe('PhoneGate', () => {
  let clock: FakeClock;
  let bus: Bus;
  let store: Store;
  let asks: Asks;
  let gate: PhoneGate;
  let away: boolean;
  let mode: 'away' | 'always';
  let mirrored: Message[];

  beforeEach(() => {
    clock = new FakeClock(T0);
    bus = new Bus();
    store = new Store({ path: ':memory:', bus, clock });
    asks = new Asks({ store, bus, clock });
    away = false;
    mode = 'away';
    mirrored = [];
    bus.on('message:mirror', (m) => mirrored.push(m));
    gate = new PhoneGate({ bus, store, clock, isUserAway: () => away, mode: () => mode });
    gate.start();
  });
  afterEach(() => {
    gate.stop();
    asks.dispose();
    store.close();
  });

  const note = (body = 'hi', extra: Partial<Parameters<Store['createMessage']>[0]> = {}) =>
    store.createMessage({ kind: 'note', body, sender: 'agent', ...extra });

  it('mirrors a note at once while the user is away', () => {
    away = true;
    const m = note();
    expect(mirrored.map((x) => x.id)).toEqual([m.id]);
    expect(gate.heldIds).toEqual([]);
  });

  it('holds a note that arrives while the user is active, and mirrors it once on the first tick after they leave', () => {
    const m = note();
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([m.id]);

    clock.advance(TICK); // still active: the tick finds nothing to do
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([m.id]);

    away = true;
    clock.advance(TICK);
    expect(mirrored.map((x) => x.id)).toEqual([m.id]);
    expect(gate.heldIds).toEqual([]);

    clock.advance(TICK * 3); // never twice
    expect(mirrored).toHaveLength(1);
  });

  it('never mirrors a held note that was dismissed before the user left', () => {
    const m = note();
    store.markDone(m.id);
    expect(gate.heldIds).toEqual([]);
    away = true;
    clock.advance(TICK);
    expect(mirrored).toEqual([]);
  });

  it('never mirrors a held ask that was answered at the desk before the user left', () => {
    const ask = asks.create({ question: 'Ship it?', sender: 'agent' });
    expect(gate.heldIds).toEqual([ask.id]);
    asks.answer(ask.id, 'yes', 'desk');
    expect(gate.heldIds).toEqual([]);
    away = true;
    clock.advance(TICK);
    expect(mirrored).toEqual([]);
  });

  it('never mirrors a held ask that was dismissed at the desk before the user left', () => {
    const ask = asks.create({ question: 'Ship it?', sender: 'agent' });
    store.markDone(ask.id); // dismissed, not answered
    expect(gate.heldIds).toEqual([]);
    away = true;
    clock.advance(TICK);
    expect(mirrored).toEqual([]);
  });

  it('escalates a held ask unanswered for 10 minutes to the phone even while the user is active', () => {
    const ask = asks.create({ question: 'Ship it?', sender: 'agent' });
    clock.advance(9 * 60_000);
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([ask.id]);
    clock.advance(60_000 + TICK); // past 10 minutes, next tick
    expect(mirrored.map((x) => x.id)).toEqual([ask.id]);
    expect(gate.heldIds).toEqual([]);
    clock.advance(TICK * 5); // once only
    expect(mirrored).toHaveLength(1);
  });

  it('does not escalate an ask that was answered, or one that is snoozed', () => {
    const answered = asks.create({ question: 'One?', sender: 'agent' });
    const snoozed = asks.create({ question: 'Two?', sender: 'agent' });
    asks.answer(answered.id, 'yes', 'desk');
    store.snooze(snoozed.id, T0 + 60 * 60_000);
    clock.advance(11 * 60_000);
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([snoozed.id]);
  });

  it('does not escalate held notes or reminders, however long they wait', () => {
    const n = note();
    const r = store.createMessage({ kind: 'reminder', body: 'stretch', sender: 'agent' });
    clock.advance(60 * 60_000);
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([n.id, r.id]);
  });

  it('mirrors a held ask once the user is away if it is still unanswered', () => {
    const ask = asks.create({ question: 'Ship it?', sender: 'agent' });
    away = true;
    clock.advance(TICK);
    expect(mirrored.map((x) => x.id)).toEqual([ask.id]);
  });

  it('keeps a snoozed held note held until it wakes and the user is away', () => {
    const m = note();
    store.snooze(m.id, T0 + 10 * TICK);
    away = true;
    clock.advance(TICK); // away, but the note is snoozed
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([m.id]);

    store.updateMessage(m.id, { state: 'unread', snoozedUntil: null }); // the scheduler's wake-up
    clock.advance(TICK);
    expect(mirrored.map((x) => x.id)).toEqual([m.id]);
    expect(gate.heldIds).toEqual([]);
  });

  it('drops a snoozed held note that is dismissed while it sleeps', () => {
    const m = note();
    store.snooze(m.id, T0 + 10 * TICK);
    store.markDone(m.id);
    away = true;
    clock.advance(TICK);
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([]);
  });

  it('mirrors at once in always mode, even at the PC', () => {
    mode = 'always';
    const m = note();
    expect(mirrored.map((x) => x.id)).toEqual([m.id]);
    expect(gate.heldIds).toEqual([]);
  });

  it('flushes held notes on the next tick when the mode is switched to always', () => {
    const m = note();
    mode = 'always';
    clock.advance(TICK);
    expect(mirrored.map((x) => x.id)).toEqual([m.id]);
  });

  it('never mirrors messages that arrive done (quiet hook notes, chat lines)', () => {
    note('✅ finished', { state: 'done' });
    store.createMessage({ kind: 'chat', role: 'user', body: 'hello', sender: 'user', state: 'done' });
    store.createMessage({ kind: 'chat', role: 'clippy', body: 'greetings', sender: 'clippy' });
    away = true;
    clock.advance(TICK);
    expect(mirrored).toEqual([]);
    expect(gate.heldIds).toEqual([]);
  });

  it('holds and mirrors fired reminders like notes', () => {
    const r = store.createMessage({ kind: 'reminder', body: 'stretch', sender: 'agent' });
    expect(gate.heldIds).toEqual([r.id]);
    away = true;
    clock.advance(TICK);
    expect(mirrored.map((x) => x.id)).toEqual([r.id]);
  });

  it('stops listening and ticking after stop()', () => {
    gate.stop();
    expect(clock.pending).toBe(0);
    note();
    away = true;
    clock.advance(TICK * 2);
    expect(mirrored).toEqual([]);
  });
});
