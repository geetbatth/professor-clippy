/** Telegram panel helpers (pure, so they are unit-tested). */
import type { TelegramStatus } from '@clippy/shared/ipc';

/** The badge next to "Telegram": connected, error or off (a token saved but not yet polling shows "…"). */
export function telegramBadge(status: TelegramStatus): 'connected' | 'error' | 'off' | '…' {
  if (!status.tokenSaved || status.state === 'off') return 'off';
  if (status.state === 'connected') return 'connected';
  if (status.state === 'error') return 'error';
  return '…';
}

/** The one-line status under the Telegram fields. */
export function telegramStatusLine(status: TelegramStatus): string {
  const bot = status.botUsername ? ` as @${status.botUsername}` : '';
  switch (status.state) {
    case 'off':
      return 'Off: save a bot token to start.';
    case 'connecting':
      return 'Connecting to Telegram…';
    case 'connected':
      return status.chatId === undefined ? `Connected${bot}; waiting for you to pair.` : `Connected${bot}.`;
    case 'error':
      return `Error: ${status.error ?? 'Telegram is not answering.'}`;
  }
}

/** A typed-in chat id, or undefined if it isn't one. */
export function parseChatId(text: string): number | undefined {
  const t = text.trim();
  if (!/^-?\d{1,16}$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n !== 0 ? n : undefined;
}
