import { describe, expect, it } from 'vitest';
import type { TelegramStatus } from '@clippy/shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '@clippy/shared/settings';
import { phoneChannels, sectionSummary, type SummaryContext } from '../../src/renderer/src/note/settings/summaries';

const paired: TelegramStatus = { tokenSaved: true, state: 'connected', chatId: 123456789 };
const ctx = (settings: Partial<Settings> = {}, rest: Partial<Omit<SummaryContext, 'settings'>> = {}): SummaryContext => ({
  settings: { ...DEFAULT_SETTINGS, ...settings },
  orders: 0,
  watches: 0,
  ...rest,
});

describe('sectionSummary', () => {
  it('history: what is in it, with the count when known', () => {
    expect(sectionSummary('history', ctx())).toBe("Everything you've dealt with");
    expect(sectionSummary('history', ctx({}, { historyCount: 12 }))).toBe("Everything you've dealt with · 12 notes");
    expect(sectionSummary('history', ctx({}, { historyCount: 1 }))).toBe("Everything you've dealt with · 1 note");
    // History shows the latest 50; the count says so rather than pretending to know more.
    expect(sectionSummary('history', ctx({}, { historyCount: 51 }))).toBe("Everything you've dealt with · 50+ notes");
  });

  it('alerts: what pops up, and the sounds', () => {
    expect(sectionSummary('alerts', ctx())).toBe('Questions, reminders & urgent · sounds on');
    expect(sectionSummary('alerts', ctx({ popUpFor: 'everything', soundEnabled: false }))).toBe('Everything · sounds off');
  });

  it('phone: when, and where to', () => {
    expect(sectionSummary('phone', ctx({ awayThresholdS: 180 }, { telegram: paired }))).toBe('Only when away (3 min) · Telegram');
    expect(sectionSummary('phone', ctx({ phoneWhen: 'always', workerUrl: 'https://r.example.workers.dev', workerSecret: 's' }, { telegram: paired }))).toBe(
      'Always · Telegram & WhatsApp',
    );
    expect(sectionSummary('phone', ctx({ workerUrl: 'https://r.example.workers.dev', workerSecret: 's' }))).toBe('Only when away (3 min) · WhatsApp');
    // 0 = always away.
    expect(sectionSummary('phone', ctx({ awayThresholdS: 0 }, { telegram: paired }))).toBe('Always · Telegram');
  });

  it('phone: neither channel is "Not set up" (a token without a paired chat does not count)', () => {
    expect(sectionSummary('phone', ctx())).toBe('Not set up');
    expect(sectionSummary('phone', ctx({}, { telegram: { tokenSaved: true, state: 'connected', pairingCode: 'K7QF3M' } }))).toBe('Not set up');
    expect(sectionSummary('phone', ctx({ workerUrl: 'https://r.example.workers.dev' }))).toBe('Not set up');
  });

  it('phoneChannels lists the channels set up', () => {
    expect(phoneChannels(DEFAULT_SETTINGS, undefined)).toEqual([]);
    expect(phoneChannels({ ...DEFAULT_SETTINGS, workerUrl: 'https://r.example.workers.dev', workerSecret: 's' }, paired)).toEqual(['Telegram', 'WhatsApp']);
  });

  it('brief: the time and the days, or off', () => {
    expect(sectionSummary('brief', ctx({ briefEnabled: true, briefTime: '09:00', briefWeekdaysOnly: true }))).toBe('09:00 · weekdays');
    expect(sectionSummary('brief', ctx({ briefTime: '07:30', briefWeekdaysOnly: false }))).toBe('07:30 · every day');
    expect(sectionSummary('brief', ctx({ briefEnabled: false }))).toBe('Off');
  });

  it('claude: the hook, the wait, phone approvals', () => {
    expect(sectionSummary('claude', ctx({ hookEnabled: true, askTimeoutDefaultS: 600, phoneApprovals: true }))).toBe(
      'Hook on · questions wait 10 min · phone approvals on',
    );
    expect(sectionSummary('claude', ctx({ askTimeoutDefaultS: 300 }))).toBe('Hook on · questions wait 5 min');
    // Approvals need the hook, so they are not claimed while it is off.
    expect(sectionSummary('claude', ctx({ hookEnabled: false, phoneApprovals: true }))).toBe('Hook off · questions wait 10 min');
  });

  it('rules: how many orders and watches', () => {
    expect(sectionSummary('rules', ctx({}, { orders: 2, watches: 1 }))).toBe('2 orders · waiting for 1');
    expect(sectionSummary('rules', ctx({}, { orders: 1, watches: 0 }))).toBe('1 order · waiting for none');
    expect(sectionSummary('rules', ctx())).toBe('None yet');
  });

  it('look: the theme, and whether it follows Windows', () => {
    expect(sectionSummary('look', ctx())).toBe('Classic yellow');
    expect(sectionSummary('look', ctx({ theme: 'mint', followSystemDark: true }))).toBe('Mint · follows Windows');
  });

  it('pc: the hotkey and starting with Windows', () => {
    expect(sectionSummary('pc', ctx({ tellHotkey: 'Control+Alt+Space', autoStart: true }))).toBe('Ctrl+Alt+Space · starts with Windows');
    expect(sectionSummary('pc', ctx({ tellHotkey: '', autoStart: true }))).toBe('No hotkey · starts with Windows');
    expect(sectionSummary('pc', ctx({ tellHotkey: '', autoStart: false }))).toBe('No hotkey');
    expect(sectionSummary('pc', ctx({ autoStart: false }, { hotkeyOk: false }))).toBe('Ctrl+Alt+Space (not working)');
  });
});
