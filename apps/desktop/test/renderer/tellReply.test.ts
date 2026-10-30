import { describe, expect, it } from 'vitest';
import type { Message } from '@clippy/shared/schemas';
import { tellReply } from '../../src/renderer/src/note/tellReply';

let n = 0;
function line(role: 'user' | 'clippy', createdAt: number, body: string = role): Message {
  n += 1;
  return { id: `01JC${String(n).padStart(22, '0')}`, kind: 'chat', role, body, sender: role, urgent: false, state: 'done', createdAt };
}

describe('tellReply', () => {
  it('is the first Clippy line created at or after the send', () => {
    const lines = [line('clippy', 50, 'old'), line('user', 100), line('clippy', 120, 'first'), line('clippy', 130, 'second')];
    expect(tellReply(lines, 100)?.body).toBe('first');
  });

  it('is undefined until Clippy has answered, and ignores earlier replies and the user own lines', () => {
    expect(tellReply([line('clippy', 50), line('user', 100)], 100)).toBeUndefined();
    expect(tellReply([], 100)).toBeUndefined();
  });

  it('copes with lines in any order', () => {
    const late = line('clippy', 300, 'late');
    const early = line('clippy', 200, 'early');
    expect(tellReply([late, early], 100)?.body).toBe('early');
  });
});
