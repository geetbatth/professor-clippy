import type { StandingOrder } from '@clippy/shared/schemas';
import { describe, expect, it } from 'vitest';
import { orderLabel } from '../../src/renderer/src/note/orderLabel';

const order: StandingOrder = { id: '01JB2Z3K4M5N6P7Q8R9S0T1V2A', text: 'When an agent asks which branch, answer: staging', active: true, createdAt: 1 };

describe('orderLabel', () => {
  it('names the standing order that answered', () => {
    expect(orderLabel(order.id, [order])).toBe('Answered by standing order: When an agent asks which branch, answer: staging');
  });

  it('copes with an order that has since been cancelled', () => {
    expect(orderLabel(order.id, [])).toBe('Answered by a standing order (since cancelled)');
  });
});
