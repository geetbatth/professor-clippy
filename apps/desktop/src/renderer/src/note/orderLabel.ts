import type { StandingOrder } from '@clippy/shared/schemas';

/** History line for an ask a standing order answered. A cancelled order is no longer listed, so it goes unnamed. */
export function orderLabel(orderId: string, orders: StandingOrder[]): string {
  const order = orders.find((o) => o.id === orderId);
  return order ? `Answered by standing order: ${order.text}` : 'Answered by a standing order (since cancelled)';
}
