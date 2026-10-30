import { Fragment, useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Settings } from '@clippy/shared/settings';
import { GroupLabel, MenuRow, Pill } from './controls';
import { phoneChannels, sectionSummary, type SettingsSection, type SummaryContext } from './summaries';

export interface SectionInfo {
  id: SettingsSection;
  icon: string;
  title: string;
}

/** The menu, top to bottom: History on its own, then the sections by group. */
export const SECTION_GROUPS: readonly { label?: string; sections: readonly SectionInfo[] }[] = [
  { sections: [{ id: 'history', icon: '🕘', title: 'History' }] },
  {
    label: 'How I behave',
    sections: [
      { id: 'alerts', icon: '🔔', title: 'Pop-ups & sounds' },
      { id: 'phone', icon: '📱', title: 'Phone' },
      { id: 'brief', icon: '☀️', title: 'Morning brief' },
    ],
  },
  {
    label: 'Agents',
    sections: [
      { id: 'claude', icon: '🤖', title: 'Claude Code' },
      { id: 'rules', icon: '📜', title: 'Standing orders & watches' },
    ],
  },
  {
    label: 'This PC',
    sections: [
      { id: 'look', icon: '🎨', title: 'Look' },
      { id: 'pc', icon: '🖥️', title: 'Windows & hotkeys' },
    ],
  },
];

export const SECTIONS: readonly SectionInfo[] = SECTION_GROUPS.flatMap((g) => g.sections);

type Counts = Omit<SummaryContext, 'settings'>;

/**
 * What the summaries need besides the settings: Telegram's state, how many orders, watches and
 * history notes there are, and whether the hotkey registered. Read once each time the menu opens.
 */
function useCounts(api: ClippyWindowApi): Counts {
  const [counts, setCounts] = useState<Counts>({ orders: 0, watches: 0 });
  useEffect(() => {
    let live = true;
    const set = (patch: Partial<Counts>) => live && setCounts((c) => ({ ...c, ...patch }));
    const ignore = () => {};
    void api.telegramStatus().then((telegram) => set({ telegram }), ignore);
    void api.listOrders().then((o) => set({ orders: o.length }), ignore);
    void api.listWatches().then((w) => set({ watches: w.length }), ignore);
    // The same list History shows (dealt-with notes, chat left out).
    void api.listMessages({ state: 'done' }).then((list) => set({ historyCount: list.filter((m) => m.kind !== 'chat').length }), ignore);
    void api.hotkeyStatus().then((h) => set({ hotkeyOk: h.ok }), ignore);
    return () => {
      live = false;
    };
  }, [api]);
  return counts;
}

/** Settings opens on this: a row per section, with what it is set to now, each opening the section. */
export function SettingsMenu({ api, settings, onOpen }: { api: ClippyWindowApi; settings: Settings; onOpen(section: SettingsSection): void }) {
  const counts = useCounts(api);
  const ctx: SummaryContext = { settings, ...counts };
  const phoneOn = phoneChannels(settings, counts.telegram).length > 0;
  return (
    <div className="settings settings-menu">
      {SECTION_GROUPS.map((group, i) => (
        <Fragment key={group.label ?? i}>
          {group.label && <GroupLabel>{group.label}</GroupLabel>}
          {group.sections.map((s) => (
            <MenuRow
              key={s.id}
              icon={s.icon}
              title={s.title}
              summary={sectionSummary(s.id, ctx)}
              {...(s.id === 'phone' && { pill: <Pill on={phoneOn}>{phoneOn ? 'on' : 'off'}</Pill> })}
              onClick={() => onOpen(s.id)}
            />
          ))}
        </Fragment>
      ))}
    </div>
  );
}
