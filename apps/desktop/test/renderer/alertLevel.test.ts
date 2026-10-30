import type { Message } from '@clippy/shared/schemas';
import { describe, expect, it } from 'vitest';
import { alertLevel } from '../../src/renderer/src/note/alertLevel';

const msg = (over: Partial<Message> = {}): Message => ({
  id: '01JAAAAAAAAAAAAAAAAAAAAAAA',
  kind: 'note',
  body: 'Build finished',
  sender: 'claude-code',
  urgent: false,
  state: 'unread',
  createdAt: 1,
  ...over,
});

describe('alertLevel', () => {
  it('questions, reminders and urgent notes are loud', () => {
    expect(alertLevel(msg({ kind: 'ask' }), 'important')).toBe('loud');
    expect(alertLevel(msg({ kind: 'reminder' }), 'important')).toBe('loud');
    expect(alertLevel(msg({ urgent: true }), 'important')).toBe('loud');
  });

  it("Clippy's own notes (nudges, the morning brief) are loud", () => {
    expect(alertLevel(msg({ sender: 'clippy' }), 'important')).toBe('loud');
  });

  it('a plain note from an agent is quiet', () => {
    expect(alertLevel(msg(), 'important')).toBe('quiet');
  });

  it('"everything" makes a plain note loud too', () => {
    expect(alertLevel(msg(), 'everything')).toBe('loud');
  });
});
