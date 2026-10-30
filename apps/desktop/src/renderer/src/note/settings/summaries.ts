/** Settings menu: its sections, and the one-line summary under each row (pure, so it is unit-tested). */
import type { TelegramStatus } from '@clippy/shared/ipc';
import type { Settings } from '@clippy/shared/settings';
import { THEMES } from '@clippy/shared/theme';
import { askWaitMinutes } from '../askWait';
import { awayMinutes } from '../awayThreshold';
import { relayBadge } from '../firstRun';

export type SettingsSection = 'history' | 'alerts' | 'phone' | 'brief' | 'claude' | 'rules' | 'look' | 'pc';

/** History shows this many of the latest notes when its search box is empty. */
export const HISTORY_RECENT_LIMIT = 50;

export interface SummaryContext {
  settings: Settings;
  /** Undefined until the menu has asked. */
  telegram?: TelegramStatus;
  /** Active standing orders and watches. */
  orders: number;
  watches: number;
  /** Notes in History (dealt-with ones, chat excluded); undefined until counted. */
  historyCount?: number;
  /** The Tell Clippy hotkey registered (false: malformed, or another app has it). */
  hotkeyOk?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Where notes go on the phone: Telegram once a chat is paired, WhatsApp once the relay is saved. */
export function phoneChannels(settings: Settings, telegram: TelegramStatus | undefined): ('Telegram' | 'WhatsApp')[] {
  const channels: ('Telegram' | 'WhatsApp')[] = [];
  if (telegram?.tokenSaved && telegram.chatId !== undefined) channels.push('Telegram');
  if (relayBadge(settings) === 'saved') channels.push('WhatsApp');
  return channels;
}

/** "Control+Alt+Space" as people write it: "Ctrl+Alt+Space". */
const hotkeyLabel = (accelerator: string) => accelerator.replace(/\b(Control|CommandOrControl|CmdOrCtrl)\b/g, 'Ctrl');

/** The summary line under a section's row in the Settings menu. */
export function sectionSummary(section: SettingsSection, ctx: SummaryContext): string {
  const s = ctx.settings;
  switch (section) {
    case 'history': {
      const what = "Everything you've dealt with";
      if (ctx.historyCount === undefined) return what;
      const count = ctx.historyCount > HISTORY_RECENT_LIMIT ? `${HISTORY_RECENT_LIMIT}+ notes` : plural(ctx.historyCount, 'note');
      return `${what} · ${count}`;
    }
    case 'alerts':
      return `${s.popUpFor === 'everything' ? 'Everything' : 'Questions, reminders & urgent'} · sounds ${s.soundEnabled ? 'on' : 'off'}`;
    case 'phone': {
      const channels = phoneChannels(s, ctx.telegram);
      if (channels.length === 0) return 'Not set up';
      const when = s.phoneWhen === 'always' || s.awayThresholdS === 0 ? 'Always' : `Only when away (${awayMinutes(s.awayThresholdS)} min)`;
      return `${when} · ${channels.join(' & ')}`;
    }
    case 'brief':
      return s.briefEnabled ? `${s.briefTime} · ${s.briefWeekdaysOnly ? 'weekdays' : 'every day'}` : 'Off';
    case 'claude': {
      const parts = [`Hook ${s.hookEnabled ? 'on' : 'off'}`, `questions wait ${askWaitMinutes(s.askTimeoutDefaultS)} min`];
      if (s.hookEnabled && s.phoneApprovals) parts.push('phone approvals on');
      return parts.join(' · ');
    }
    case 'rules':
      if (ctx.orders === 0 && ctx.watches === 0) return 'None yet';
      return `${plural(ctx.orders, 'order')} · waiting for ${ctx.watches === 0 ? 'none' : ctx.watches}`;
    case 'look': {
      const label = THEMES.find((t) => t.id === s.theme)?.label ?? s.theme;
      return s.followSystemDark ? `${label} · follows Windows` : label;
    }
    case 'pc': {
      const hotkey = s.tellHotkey ? `${hotkeyLabel(s.tellHotkey)}${ctx.hotkeyOk === false ? ' (not working)' : ''}` : 'No hotkey';
      return s.autoStart ? `${hotkey} · starts with Windows` : hotkey;
    }
  }
}
