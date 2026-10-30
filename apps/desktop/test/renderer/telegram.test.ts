import { describe, expect, it } from 'vitest';
import { createMockBackend } from '../../src/renderer/src/mock/mockBackend';
import { parseChatId, telegramBadge, telegramStatusLine } from '../../src/renderer/src/note/telegram';

describe('Telegram panel helpers', () => {
  it('badges and status lines', () => {
    expect(telegramBadge({ tokenSaved: false, state: 'off' })).toBe('off');
    expect(telegramBadge({ tokenSaved: true, state: 'connecting' })).toBe('…');
    expect(telegramBadge({ tokenSaved: true, state: 'connected' })).toBe('connected');
    expect(telegramBadge({ tokenSaved: true, state: 'error', error: 'x' })).toBe('error');
    expect(telegramStatusLine({ tokenSaved: false, state: 'off' })).toMatch(/save a bot token/);
    expect(telegramStatusLine({ tokenSaved: true, state: 'connected', botUsername: 'Bot' })).toBe('Connected as @Bot; waiting for you to pair.');
    expect(telegramStatusLine({ tokenSaved: true, state: 'connected', botUsername: 'Bot', chatId: 1 })).toBe('Connected as @Bot.');
    expect(telegramStatusLine({ tokenSaved: true, state: 'error', error: 'Telegram rejected the bot token (401 Unauthorized).' })).toBe(
      'Error: Telegram rejected the bot token (401 Unauthorized).',
    );
  });

  it('parses a typed chat id', () => {
    expect(parseChatId(' 123456789 ')).toBe(123456789);
    expect(parseChatId('-1001234567890')).toBe(-1001234567890);
    expect(parseChatId('12a')).toBeUndefined();
    expect(parseChatId('0')).toBeUndefined();
    expect(parseChatId('')).toBeUndefined();
  });
});

describe('mock backend: Telegram', () => {
  it('saves a token, pairs with the code, tests, unpairs and clears', async () => {
    const api = createMockBackend();
    expect(await api.telegramStatus()).toEqual({ tokenSaved: false, state: 'off' });
    await expect(api.setTelegramToken('nope')).rejects.toThrow(/bot token/);
    const saved = await api.setTelegramToken('123456789:AAHfakefakefakefakefakefake');
    expect(saved).toMatchObject({ tokenSaved: true, state: 'connected', pairingCode: 'K7QF3M' });
    expect(await api.telegramSendTest()).toMatchObject({ ok: false });
    expect(api.telegramStart('wrong')).toBe(false);
    expect(api.telegramStart('k7qf3m', { id: 42, firstName: 'Geet' })).toBe(true);
    expect(await api.telegramStatus()).toMatchObject({ chatId: 42, chatName: 'Geet' });
    expect(await api.telegramSendTest()).toEqual({ ok: true });
    expect(await api.telegramUnpair()).toMatchObject({ pairingCode: 'K7QF3M' });
    expect(await api.setTelegramToken(null)).toEqual({ tokenSaved: false, state: 'off' });
  });
});
