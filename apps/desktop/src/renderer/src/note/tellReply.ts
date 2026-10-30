import type { Message } from '@clippy/shared/schemas';

/**
 * Clippy's reply to a line sent from the Tell Clippy box: the first of his chat lines created at
 * or after `sentAt` (epoch ms, taken just before sending). Undefined while he is still working.
 */
export function tellReply(lines: readonly Message[], sentAt: number): Message | undefined {
  return lines
    .filter((m) => m.role === 'clippy' && m.createdAt >= sentAt)
    .sort((a, b) => a.createdAt - b.createdAt)[0];
}
