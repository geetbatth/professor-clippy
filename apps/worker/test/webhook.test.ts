import { describe, expect, it } from 'vitest';
import { extractInboundTexts, normalizeNumber } from '../src/webhook';
import { webhookPayload } from './helpers';

const ME = '447700900123';
const NOW = 1_800_000_000_000;

describe('extractInboundTexts', () => {
  it('returns text messages from MY_NUMBER with context and ms timestamps', () => {
    const payload = webhookPayload([
      { from: ME, id: 'wamid.in1', timestamp: '1790000000', type: 'text', text: { body: 'hello\nthere' } },
      {
        from: ME,
        id: 'wamid.in2',
        timestamp: '1790000005',
        type: 'text',
        text: { body: 'yes, ship it' },
        context: { from: '15550001111', id: 'wamid.ask' },
      },
    ]);
    expect(extractInboundTexts(payload, ME, NOW)).toEqual([
      { id: 'wamid.in1', text: 'hello\nthere', ts: 1_790_000_000_000 },
      { id: 'wamid.in2', text: 'yes, ship it', contextWaId: 'wamid.ask', ts: 1_790_000_005_000 },
    ]);
  });

  it('ignores other senders, non-text messages and status updates', () => {
    const payload = webhookPayload(
      [
        { from: '15559998888', id: 'wamid.stranger', timestamp: '1790000000', type: 'text', text: { body: 'hi' } },
        { from: ME, id: 'wamid.img', timestamp: '1790000000', type: 'image' },
      ],
      { statuses: [{ id: 'wamid.out', status: 'delivered' }] },
    );
    expect(extractInboundTexts(payload, ME, NOW)).toEqual([]);
    const statusOnly = {
      entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'wamid.out', status: 'read' }] } }] }],
    };
    expect(extractInboundTexts(statusOnly, ME, NOW)).toEqual([]);
  });

  it('matches MY_NUMBER written with + and spaces', () => {
    const payload = webhookPayload([{ from: ME, id: 'wamid.a', timestamp: '1', type: 'text', text: { body: 'x' } }]);
    expect(extractInboundTexts(payload, '+44 7700 900123', NOW)).toHaveLength(1);
    expect(normalizeNumber('+44 (7700) 900-123')).toBe(ME);
  });

  it('skips malformed messages and payloads, and falls back to now for a bad timestamp', () => {
    expect(extractInboundTexts({ hello: 'world' }, ME, NOW)).toEqual([]);
    expect(extractInboundTexts(null, ME, NOW)).toEqual([]);
    const payload = webhookPayload([
      { from: ME, id: 'wamid.ok', timestamp: 'soon', type: 'text', text: { body: 'x' } },
      { bogus: true } as never,
    ]);
    expect(extractInboundTexts(payload, ME, NOW)).toEqual([{ id: 'wamid.ok', text: 'x', ts: NOW }]);
  });

  it('accepts nothing when MY_NUMBER is unset', () => {
    const payload = webhookPayload([{ from: ME, id: 'wamid.a', timestamp: '1', type: 'text', text: { body: 'x' } }]);
    expect(extractInboundTexts(payload, '', NOW)).toEqual([]);
  });
});
