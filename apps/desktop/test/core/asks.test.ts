import { AskResult, Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asks } from '../../src/main/core/asks';
import { Bus, type CoreEventMap } from '../../src/main/core/bus';
import { ConflictError, NotFoundError } from '../../src/main/core/errors';
import { Store } from '../../src/main/core/store';
import { FakeClock } from './fakeClock';

const T0 = Date.UTC(2026, 9, 30, 9);

describe('Asks', () => {
  let clock: FakeClock;
  let bus: Bus;
  let store: Store;
  let asks: Asks;
  let answered: CoreEventMap['ask:answered'][];

  beforeEach(() => {
    clock = new FakeClock(T0);
    bus = new Bus();
    store = new Store({ path: ':memory:', bus, clock });
    asks = new Asks({ store, bus, clock });
    answered = [];
    bus.on('ask:answered', (e) => answered.push(e));
  });
  afterEach(() => {
    asks.dispose();
    store.close();
  });

  const ask = (): Message =>
    asks.create({ question: 'Ship it?', options: ['yes', 'no'], sender: 'claude-code', project: 'clippy', urgent: true });

  it('creates an ask Message', () => {
    const m = ask();
    expect(Message.parse(m)).toEqual(m);
    expect(m).toMatchObject({
      kind: 'ask',
      body: 'Ship it?',
      options: ['yes', 'no'],
      sender: 'claude-code',
      project: 'clippy',
      urgent: true,
      state: 'unread',
    });
    expect(asks.result(m.id)).toEqual({ id: m.id, status: 'pending' });
    expect(asks.listPending().map((x) => x.id)).toEqual([m.id]);
  });

  it('creates an ask already answered by a standing order, and wait resolves at once', async () => {
    const order = store.insertOrder('say yes');
    const m = asks.create({ question: 'Ship it?', options: ['yes', 'no'], sender: 'claude-code' }, { orderId: order.id, answer: 'yes' });
    expect(Message.parse(m)).toEqual(m);
    expect(m).toMatchObject({ kind: 'ask', state: 'done', answer: 'yes', answeredVia: 'clippy', orderId: order.id, doneAt: T0 });
    expect(asks.result(m.id)).toEqual({ id: m.id, status: 'answered', answer: 'yes', answeredVia: 'clippy' });
    await expect(asks.wait(m.id, 60_000)).resolves.toEqual({ id: m.id, status: 'answered', answer: 'yes', answeredVia: 'clippy' });
    expect(asks.waiterCount).toBe(0);
    expect(asks.listPending()).toEqual([]);
    expect(() => asks.answer(m.id, 'no', 'desk')).toThrow(ConflictError);
  });

  it('long-poll resolves with the answer as soon as it is given', async () => {
    const m = ask();
    const waiting = asks.wait(m.id, 60_000);
    const second = asks.wait(m.id, 30_000);
    expect(asks.waiterCount).toBe(2);
    clock.advance(5_000);

    const result = asks.answer(m.id, 'yes', 'desk');
    expect(result).toEqual({ id: m.id, status: 'answered', answer: 'yes', answeredVia: 'desk' });
    await expect(waiting).resolves.toEqual(result);
    await expect(second).resolves.toEqual(result);
    expect(AskResult.parse(result)).toEqual(result);
    expect(asks.waiterCount).toBe(0);
    expect(clock.pending).toBe(0); // timeouts cleared
  });

  it('long-poll returns pending when the wait times out', async () => {
    const m = ask();
    let settled: AskResult | undefined;
    void asks.wait(m.id, 10_000).then((r) => (settled = r));
    clock.advance(9_999);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    clock.advance(1);
    await Promise.resolve();
    expect(settled).toEqual({ id: m.id, status: 'pending' });
    expect(asks.waiterCount).toBe(0);
  });

  it('returns immediately for wait 0 or an already answered ask', async () => {
    const m = ask();
    await expect(asks.wait(m.id, 0)).resolves.toEqual({ id: m.id, status: 'pending' });
    asks.answer(m.id, 'no', 'whatsapp');
    await expect(asks.wait(m.id, 60_000)).resolves.toEqual({ id: m.id, status: 'answered', answer: 'no', answeredVia: 'whatsapp' });
    expect(clock.pending).toBe(0);
  });

  it('an aborted wait resolves pending and stops waiting', async () => {
    const m = ask();
    const controller = new AbortController();
    const waiting = asks.wait(m.id, 60_000, controller.signal);
    controller.abort();
    await expect(waiting).resolves.toEqual({ id: m.id, status: 'pending' });
    expect(asks.waiterCount).toBe(0);
    expect(clock.pending).toBe(0);
  });

  it('answering marks the ask done, emits message:updated and ask:answered', () => {
    const m = ask();
    const updates: Message[] = [];
    bus.on('message:updated', (x) => updates.push(x));
    clock.advance(1_000);
    const result = asks.answer(m.id, 'yes', 'clippy');

    const stored = store.getMessage(m.id)!;
    expect(stored).toMatchObject({ state: 'done', doneAt: T0 + 1_000, answer: 'yes', answeredVia: 'clippy' });
    expect(updates).toEqual([stored]);
    expect(answered).toEqual([{ message: stored, result }]);
    expect(asks.listPending()).toEqual([]);
  });

  it('rejects answering twice with ConflictError (409) and keeps the first answer', () => {
    const m = ask();
    asks.answer(m.id, 'yes', 'desk');
    expect(() => asks.answer(m.id, 'no', 'whatsapp')).toThrow(ConflictError);
    expect(store.getMessage(m.id)!.answer).toBe('yes');
    expect(answered).toHaveLength(1);
  });

  it('unknown ids and non-ask messages are NotFoundError (404)', () => {
    const note = store.createMessage({ kind: 'note', body: 'n', sender: 's' });
    expect(() => asks.result('01ARZ3NDEKTSV4RRFFQ69G5FAV')).toThrow(NotFoundError);
    expect(() => asks.wait(note.id, 1000)).toThrow(NotFoundError);
    expect(() => asks.answer(note.id, 'x', 'desk')).toThrow(NotFoundError);
  });

  it('dispose() releases every waiter as pending', async () => {
    const m = ask();
    const waiting = asks.wait(m.id, 60_000);
    asks.dispose();
    await expect(waiting).resolves.toEqual({ id: m.id, status: 'pending' });
    expect(clock.pending).toBe(0);
  });
});
