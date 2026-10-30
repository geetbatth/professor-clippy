import { ChecklistItem, Message } from '@clippy/shared/schemas';
import { DEFAULT_SETTINGS, SettingsPatch } from '@clippy/shared/settings';
import { describe, expect, it } from 'vitest';
import { nextStep, relayBadge, relayPatch, WIZARD_STEPS } from '../../src/renderer/src/note/firstRun';
import { CHECKLIST, checklistProgress, demoQuestion, howTo, showChecklist, tellLine } from '../../src/renderer/src/note/welcome/tour';

describe('first-run wizard', () => {
  it('goes Claude Code → look → phone → try it, then finishes', () => {
    expect(WIZARD_STEPS).toEqual(['claude', 'look', 'phone', 'tour']);
    expect(nextStep('claude')).toBe('look');
    expect(nextStep('look')).toBe('phone');
    expect(nextStep('phone')).toBe('tour');
    expect(nextStep('tour')).toBeUndefined();
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

  it('Settings: the same checks; an empty secret keeps the saved one and changes only the URL', () => {
    const saved = { secretSaved: true };
    expect(relayPatch(' https://relay-two.me.workers.dev/ ', '', saved)).toEqual({
      patch: { workerUrl: 'https://relay-two.me.workers.dev' },
    });
    expect(relayPatch('https://relay.me.workers.dev', ' new-secret ', saved)).toEqual({
      patch: { workerUrl: 'https://relay.me.workers.dev', workerSecret: 'new-secret' },
    });
    expect(relayPatch('http://relay.example.workers.dev', '', saved)).toEqual({ error: expect.stringMatching(/must start with https/) });
    expect(relayPatch('ftp://relay.example.workers.dev', 'x', saved)).toEqual({ error: expect.stringMatching(/must start with https/) });
    expect(relayPatch('https://relay.example.workers.dev', '   ', { secretSaved: false })).toEqual({
      error: expect.stringMatching(/PC_SECRET/),
    });
  });

  it('labels a configured relay "saved", not "connected" (there is no live state to show)', () => {
    expect(relayBadge({ workerUrl: 'https://r.workers.dev', workerSecret: 's' })).toBe('saved');
    expect(relayBadge({ workerUrl: 'https://r.workers.dev' })).toBe('off');
    expect(relayBadge({})).toBe('off');
  });
});

describe('the welcome tour and Getting started', () => {
  const state = (done: ChecklistItem[], dismissed = false) => ({ startedAt: 0, done, dismissed, tipsShown: [] });

  it('lists the seven items in order, with their labels', () => {
    expect(CHECKLIST.map((c) => c.item)).toEqual(ChecklistItem.options);
    expect(CHECKLIST.map((c) => c.label)).toEqual([
      'Connect Claude Code',
      'Answer a question',
      'Tell me something with the hotkey',
      'Snooze a note until later',
      'Set a standing order',
      'Pin a page to the desktop',
      'Get your morning brief',
    ]);
  });

  it('counts what is done and shows the row until all is done or it is dismissed', () => {
    expect(checklistProgress(state(['connect', 'answer', 'hotkey']))).toEqual({ done: 3, total: 7 });
    expect(showChecklist(state([]))).toBe(true);
    expect(showChecklist(state(['connect'], true))).toBe(false);
    expect(showChecklist(state([...ChecklistItem.options]))).toBe(false);
    expect(showChecklist(undefined)).toBe(false);
  });

  it('has a one-line how-to for every item, naming the hotkey and the brief time', () => {
    for (const { item } of CHECKLIST) expect(howTo(item, DEFAULT_SETTINGS)).toMatch(/\S/);
    expect(howTo('hotkey', DEFAULT_SETTINGS)).toContain('Ctrl+Alt+Space');
    expect(howTo('hotkey', { ...DEFAULT_SETTINGS, tellHotkey: '' })).toContain('Tell Clippy');
    expect(howTo('brief', DEFAULT_SETTINGS)).toContain('09:00');
    expect(howTo('brief', { ...DEFAULT_SETTINGS, briefEnabled: false })).toContain('Settings → Morning brief');
  });

  it('the tour names the hotkey, or the box under the notes without one', () => {
    expect(tellLine('Control+Alt+Space')).toBe("Press Ctrl+Alt+Space from any app and tell me things, like 'jot down: hello'.");
    expect(tellLine('')).toBe("Use the box under your notes and tell me things, like 'jot down: hello'.");
  });

  it('the practice question is a real-looking ask with Tea / Coffee, never stored', () => {
    const q = demoQuestion(Date.UTC(2026, 9, 30, 9));
    expect(Message.parse(q)).toEqual(q);
    expect(q).toMatchObject({ kind: 'ask', body: 'Tea or coffee?', options: ['Tea', 'Coffee'], state: 'unread' });
  });
});
