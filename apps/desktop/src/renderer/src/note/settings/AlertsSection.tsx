import type { Settings } from '@clippy/shared/settings';
import { SettingRow, ToggleSetting, type SectionProps } from './controls';

/** Settings → Pop-ups & sounds: what makes me pop up, sounds, fullscreen apps, advice. */
export function AlertsSection({ settings, update }: SectionProps) {
  return (
    <>
      <SettingRow label="Pop up for" hint="Anything else waits quietly under my unread badge.">
        <select
          className="field-input setting-select"
          value={settings.popUpFor}
          aria-label="What makes me pop up"
          onChange={(e) => void update({ popUpFor: e.target.value as Settings['popUpFor'] })}
        >
          <option value="important">Questions, reminders &amp; urgent</option>
          <option value="everything">Everything</option>
        </select>
      </SettingRow>
      <ToggleSetting name="soundEnabled" settings={settings} update={update} />
      <ToggleSetting name="hideOnFullscreen" settings={settings} update={update} />
      <ToggleSetting name="unsolicitedAdvice" settings={settings} update={update} />
    </>
  );
}
