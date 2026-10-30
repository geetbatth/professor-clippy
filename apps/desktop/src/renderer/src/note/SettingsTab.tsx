import { useEffect, useRef } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { SettingsState } from '../hooks/useSettings';
import { HistoryTab } from './HistoryTab';
import { RulesSection } from './RulesSection';
import { AlertsSection } from './settings/AlertsSection';
import { BriefSection } from './settings/BriefSection';
import { ClaudeSection } from './settings/ClaudeSection';
import type { SectionProps } from './settings/controls';
import { LookSection } from './settings/LookSection';
import { PcSection } from './settings/PcSection';
import { PhoneSection } from './settings/PhoneSection';
import { SECTIONS, SettingsMenu } from './settings/SettingsMenu';
import type { SettingsSection } from './settings/summaries';
import './SettingsTab.css';

/**
 * The Settings tab: a menu of sections (`settings/SettingsMenu`), or the open `section` under a
 * "‹ Settings" link back to the menu. Which one is open lives in `App`, so other parts of the
 * note can open a section directly (`openSettings`).
 */
export function SettingsTab({
  api,
  state,
  section,
  onSection,
}: {
  api: ClippyWindowApi;
  state: SettingsState;
  /** The open section; undefined shows the menu. */
  section: SettingsSection | undefined;
  onSection(section?: SettingsSection): void;
}) {
  const { settings, update, error } = state;
  const ref = useRef<HTMLDivElement>(null);

  // A section (or the menu) opens at its top, not wherever the last one was scrolled to.
  useEffect(() => {
    ref.current?.parentElement?.scrollTo?.(0, 0);
  }, [section]);

  if (!settings) return <p className="settings-loading">Fetching my notes…</p>;
  const props: SectionProps = { api, settings, update };
  const title = SECTIONS.find((s) => s.id === section)?.title;

  return (
    <div ref={ref} className="settings-tab">
      {section === undefined ? (
        <SettingsMenu api={api} settings={settings} onOpen={onSection} />
      ) : (
        <div className="settings">
          <button type="button" className="settings-back" onClick={() => onSection()}>
            ‹ Settings
          </button>
          <h2 className="settings-title">{title}</h2>
          {section === 'history' && <HistoryTab api={api} />}
          {section === 'alerts' && <AlertsSection {...props} />}
          {section === 'phone' && <PhoneSection {...props} />}
          {section === 'brief' && <BriefSection {...props} />}
          {section === 'claude' && <ClaudeSection {...props} />}
          {section === 'rules' && <RulesSection api={api} />}
          {section === 'look' && <LookSection {...props} />}
          {section === 'pc' && <PcSection {...props} />}
        </div>
      )}
      {error && <p className="card-error">Couldn't save that: {error}</p>}
    </div>
  );
}
