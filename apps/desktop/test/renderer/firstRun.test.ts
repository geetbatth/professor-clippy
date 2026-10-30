import { SettingsPatch } from '@clippy/shared/settings';
import { describe, expect, it } from 'vitest';
import { nextStep, relayPatch, WIZARD_STEPS } from '../../src/renderer/src/note/firstRun';

describe('first-run wizard', () => {
  it('goes WhatsApp → preferences → Claude Code, then finishes', () => {
    expect(WIZARD_STEPS).toEqual(['whatsapp', 'prefs', 'claude']);
    expect(nextStep('whatsapp')).toBe('prefs');
    expect(nextStep('prefs')).toBe('claude');
    expect(nextStep('claude')).toBeUndefined();
  });

  it('accepts a Worker URL and secret, trimmed, as a valid settings patch', () => {
    const result = relayPatch('  https://professor-clippy-relay.me.workers.dev/ ', ' s3cret ');
    expect(result).toEqual({ patch: { workerUrl: 'https://professor-clippy-relay.me.workers.dev', workerSecret: 's3cret' } });
    expect(SettingsPatch.safeParse((result as { patch: unknown }).patch).success).toBe(true);
    expect(relayPatch('http://localhost:8787', 'x')).toEqual({ patch: { workerUrl: 'http://localhost:8787', workerSecret: 'x' } });
  });

  it('explains what is wrong instead of saving', () => {
    expect(relayPatch('', 's')).toEqual({ error: expect.stringMatching(/Worker URL/) });
    expect(relayPatch('relay.workers.dev', 's')).toEqual({ error: expect.stringMatching(/https:\/\//) });
    expect(relayPatch('http://relay.example.workers.dev', 's')).toEqual({ error: expect.stringMatching(/must start with https/) });
    expect(relayPatch('https://relay.example.workers.dev', '  ')).toEqual({ error: expect.stringMatching(/PC_SECRET/) });
  });
});
