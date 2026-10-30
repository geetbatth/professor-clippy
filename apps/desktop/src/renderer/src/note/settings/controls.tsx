/** The pieces every Settings section is made of: a labelled row, an on/off switch, a menu-style row. */
import type { ReactNode } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Settings, SettingsPatch } from '@clippy/shared/settings';

/** What each section gets: the backend, the loaded settings, and a way to save a change. */
export interface SectionProps {
  api: ClippyWindowApi;
  settings: Settings;
  update(patch: SettingsPatch): Promise<boolean>;
}

type Toggle = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

/** The label and hint of every on/off setting. */
const TOGGLES = {
  hookEnabled: { label: 'Claude Code hook', hint: 'Leave a note when an agent finishes or needs permission.' },
  phoneApprovals: {
    label: 'Approve agents from my phone',
    hint: "When you're away, an agent's 'allow this?' prompt comes to your phone with Allow / Deny. Needs the hook.",
  },
  soundEnabled: { label: 'Sounds', hint: 'Dings, boings and knocks on the glass.' },
  unsolicitedAdvice: { label: 'Unsolicited advice', hint: 'Wisdom, every 30–90 minutes, whether you like it or not.' },
  briefEnabled: { label: 'Morning brief', hint: 'A note from me each morning: your reminders, what waits on you, what the agents did overnight.' },
  briefWeekdaysOnly: { label: 'Weekdays only', hint: 'Even a professor rests at the weekend. Applies to the morning brief.' },
  hideOnFullscreen: { label: 'Hide during fullscreen apps', hint: 'Games, films and presentations stay Clippy-free.' },
  autoStart: { label: 'Start with Windows', hint: 'Clippy turns up for work when you do.' },
  allowPowerActions: { label: 'Let Clippy restart apps and the PC', hint: 'Clippy still asks you to tap Restart first.' },
  followSystemDark: { label: 'Follow Windows dark mode', hint: "The dark paper while Windows is dark, and back again when it isn't." },
  showTips: { label: 'Show tips', hint: 'Now and then I point out something about the app you have overlooked.' },
} satisfies Partial<Record<Toggle, { label: string; hint: string }>>;

/** A setting's row: its label and hint on the left, its control (`children`) on the right. */
export function SettingRow({ label, hint, children }: { label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <label className="setting">
      <span className="setting-text">
        <span className="setting-label">{label}</span>
        <span className="setting-hint">{hint}</span>
      </span>
      {children}
    </label>
  );
}

/** An on/off setting as a switch, saved the moment it is flipped. */
export function ToggleSetting({ name, settings, update, disabled = false }: { name: keyof typeof TOGGLES; disabled?: boolean } & Omit<SectionProps, 'api'>) {
  const text = TOGGLES[name];
  return (
    <SettingRow label={text.label} hint={text.hint}>
      <input
        type="checkbox"
        className="switch"
        checked={settings[name]}
        disabled={disabled}
        onChange={(e) => void update({ [name]: e.target.checked })}
      />
    </SettingRow>
  );
}

/** A small uppercase heading over a group of rows ("HOW I BEHAVE", "WHERE IT GOES"). */
export function GroupLabel({ children }: { children: ReactNode }) {
  return <p className="settings-label">{children}</p>;
}

/**
 * A row that opens something: icon, bold title, a one-line summary (ellipsised unless `open`),
 * an optional status pill, and a › (turned down while `open`).
 */
export function MenuRow({
  icon,
  title,
  summary,
  pill,
  open,
  onClick,
}: {
  icon: string;
  title: string;
  summary: string;
  pill?: ReactNode;
  /** Set for a row that unfolds in place; it gets `aria-expanded`. */
  open?: boolean;
  onClick(): void;
}) {
  return (
    <button type="button" className={`settings-row${open ? ' settings-row--open' : ''}`} aria-expanded={open} onClick={onClick}>
      <span className="settings-row-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-row-text">
        <span className="settings-row-title">{title}</span>
        <span className="settings-row-summary">{summary}</span>
      </span>
      {pill}
      <span className="settings-row-chevron" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

/** A status pill: green for on / saved / connected, grey for off. */
export function Pill({ on, children, title }: { on: boolean; children: ReactNode; title?: string }) {
  return (
    <span className={on ? 'relay-on' : 'relay-off'} {...(title !== undefined && { title })}>
      {children}
    </span>
  );
}
