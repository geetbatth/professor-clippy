import { describe, expect, it } from 'vitest';
import { StreamJsonParser, type BrainStreamEvent } from '../../src/main/brain/streamParser';
import { fixture, type FixtureName } from './fixtures';

function parse(name: FixtureName, chunk = 23) {
  const events: BrainStreamEvent[] = [];
  const parser = new StreamJsonParser((e) => events.push(e));
  const text = fixture(name);
  for (let i = 0; i < text.length; i += chunk) parser.push(text.slice(i, i + chunk));
  parser.end();
  const deltas = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text);
  return { parser, events, deltas };
}

describe('StreamJsonParser', () => {
  it('recorded run: streams the partial text once, reports the session and a successful result', () => {
    const { parser, events, deltas } = parse('pong');
    expect(deltas).toEqual(['p', 'ong']);
    expect(parser.reply).toBe('pong');
    expect(parser.sessionId).toBe('27cd1719-270d-4ff7-b798-5c362f340594');
    expect(events.filter((e) => e.type === 'session')).toHaveLength(1);
    expect(parser.result).toMatchObject({ ok: true, text: 'pong', errors: [] });
    expect(parser.authFailed).toBe(false);
  });

  it('joins text blocks around a tool call, ignores tool_use and subagent lines', () => {
    const { parser, deltas } = parse('tool-turn');
    expect(parser.reply).toBe('Let me consult my ledger.\n\nOne reminder: stretch at 9 tomorrow.');
    expect(deltas.join('')).toBe(parser.reply);
    expect(parser.reply).not.toContain('SUBAGENT');
    expect(parser.result).toMatchObject({ ok: true, text: 'One reminder: stretch at 9 tomorrow.' });
  });

  it('without partial messages, uses whole assistant messages', () => {
    const { parser, deltas } = parse('no-partials');
    expect(deltas).toEqual(['Ahem.', '\n\nYou have no reminders.']);
    expect(parser.reply).toBe('Ahem.\n\nYou have no reminders.');
  });

  it('recorded "not logged in" run: flags the auth failure and a failed result', () => {
    const { parser, deltas } = parse('not-logged-in');
    expect(parser.authFailed).toBe(true);
    expect(deltas).toEqual([]); // the synthetic error text is not streamed as Clippy's reply
    expect(parser.result).toMatchObject({ ok: false, text: 'Not logged in · Please run /login' });
  });

  it('recorded missing --resume session: an error result with the CLI message', () => {
    const { parser } = parse('resume-missing');
    expect(parser.result?.ok).toBe(false);
    expect(parser.result?.errors[0]).toMatch(/No conversation found with session ID/);
    expect(parser.reply).toBe('');
  });

  it('keeps blocks of separate streamed messages apart even without api_message_id', () => {
    const parser = new StreamJsonParser();
    const line = (event: object) => `${JSON.stringify({ type: 'stream_event', event, parent_tool_use_id: null })}\n`;
    const delta = (text: string) => line({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    parser.push(line({ type: 'message_start', message: { content: [] } }) + delta('Let me look.'));
    parser.push(line({ type: 'message_start', message: { content: [] } }) + delta('Found it') + delta('.'));
    expect(parser.reply).toBe('Let me look.\n\nFound it.');
  });

  it('skips blank, malformed and unknown lines, and handles CRLF and a final line without newline', () => {
    const events: BrainStreamEvent[] = [];
    const parser = new StreamJsonParser((e) => events.push(e));
    parser.push('\r\nnot json\r\n{"type":"mystery"}\r\n[1,2]\r\n');
    parser.push('{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"s1"}');
    expect(parser.result).toBeUndefined();
    parser.end();
    expect(parser.result).toMatchObject({ ok: true, text: 'done', sessionId: 's1' });
    expect(events.map((e) => e.type)).toEqual(['session', 'result']);
  });
});
