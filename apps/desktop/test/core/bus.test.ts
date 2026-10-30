import type { Message } from '@clippy/shared';
import { describe, expect, it } from 'vitest';
import { Bus, type CoreEvent } from '../../src/main/core/bus';

const msg = { id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', kind: 'note', body: 'b', sender: 's', urgent: false, state: 'unread', createdAt: 1 } satisfies Message;

describe('Bus', () => {
  it('delivers typed payloads to subscribers until they unsubscribe', () => {
    const bus = new Bus();
    const seen: Message[] = [];
    const off = bus.on('message:new', (m) => seen.push(m));
    bus.emit('message:new', msg);
    bus.emit('message:updated', msg);
    off();
    bus.emit('message:new', msg);
    expect(seen).toEqual([msg]);
  });

  it('isolates a throwing listener so the others (and the emitter) carry on', () => {
    const errors: [CoreEvent, unknown][] = [];
    const bus = new Bus((event, err) => errors.push([event, err]));
    const seen: string[] = [];
    bus.on('message:new', () => {
      throw new Error('boom');
    });
    bus.on('message:new', (m) => seen.push(m.id));
    expect(() => bus.emit('message:new', msg)).not.toThrow();
    expect(seen).toEqual([msg.id]);
    expect(errors).toEqual([['message:new', new Error('boom')]]);
  });
});
