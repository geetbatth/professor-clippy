/**
 * The welcome's "Try it" step and the Pad's Getting started list (pure): the seven things worth
 * trying once, how to do each, and the practice question.
 */
import type { ChecklistItem, Message, OnboardingState } from '@clippy/shared/schemas';
import type { Settings } from '@clippy/shared/settings';
import { ulid } from 'ulid';
import { hotkeyLabel } from '../settings/summaries';
import type { SettingsSection } from '../settings/summaries';

/** The Getting started list, in order; `section` is where Settings sets it up, if anywhere. */
export const CHECKLIST: readonly { item: ChecklistItem; label: string; section?: SettingsSection }[] = [
  { item: 'connect', label: 'Connect Claude Code', section: 'claude' },
  { item: 'answer', label: 'Answer a question' },
  { item: 'hotkey', label: 'Tell me something with the hotkey' },
  { item: 'snooze', label: 'Snooze a note until later' },
  { item: 'order', label: 'Set a standing order', section: 'rules' },
  { item: 'popout', label: 'Pin a page to the desktop' },
  { item: 'brief', label: 'Get your morning brief', section: 'brief' },
];

export function checklistProgress(state: OnboardingState): { done: number; total: number } {
  return { done: CHECKLIST.filter((c) => state.done.includes(c.item)).length, total: CHECKLIST.length };
}

/** The Pad shows the Getting started row until everything is ticked or it is dismissed. */
export function showChecklist(state: OnboardingState | undefined): boolean {
  if (!state || state.dismissed) return false;
  const { done, total } = checklistProgress(state);
  return done < total;
}

type HowToSettings = Pick<Settings, 'tellHotkey' | 'briefEnabled' | 'briefTime' | 'briefWeekdaysOnly'>;

/** One line on how to tick `item`. */
export function howTo(item: ChecklistItem, settings: HowToSettings): string {
  switch (item) {
    case 'connect':
      return 'Settings → Claude Code → Connect Claude Code. I show you every change before I make it.';
    case 'answer':
      return "When an agent asks you something, tap an answer on its card (or reply from your phone).";
    case 'hotkey':
      return settings.tellHotkey
        ? `Press ${hotkeyLabel(settings.tellHotkey)} in any app and type, say, "remind me at 3 to call Dave".`
        : 'Type into the "Tell Clippy…" box under your notes, say, "remind me at 3 to call Dave".';
    case 'snooze':
      return 'Press Snooze on a note and I bring it back when you said.';
    case 'order':
      return 'Tell me "whenever an agent asks about X, say Y", or add one in Settings → Standing orders & watches.';
    case 'popout':
      return 'Open a page and press 📌 Pin out: it floats on your desktop.';
    case 'brief':
      return settings.briefEnabled
        ? `I leave it at ${settings.briefTime}${settings.briefWeekdaysOnly ? ' on weekdays' : ' every day'}. Patience.`
        : 'Turn it on in Settings → Morning brief and I leave you one each morning.';
  }
}

/** The "Try it" step's last line: the Tell Clippy hotkey, or the box under the notes without one. */
export function tellLine(accelerator: string): string {
  return accelerator
    ? `Press ${hotkeyLabel(accelerator)} from any app and tell me things, like 'jot down: hello'.`
    : "Use the box under your notes and tell me things, like 'jot down: hello'.";
}

/**
 * The practice question in "Try it". Rendered with the real AskCard but kept in the renderer: it is
 * never stored, mirrored or sent to an agent.
 */
export function demoQuestion(now: number): Message {
  return {
    id: ulid(now),
    kind: 'ask',
    body: 'Tea or coffee?',
    options: ['Tea', 'Coffee'],
    sender: 'Professor Clippy',
    project: 'practice',
    urgent: false,
    state: 'unread',
    createdAt: now,
  };
}
