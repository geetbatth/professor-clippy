import { SettingRow, ToggleSetting, type SectionProps } from './controls';

/** Settings → Morning brief: on or off, when, and whether weekends get one. */
export function BriefSection({ settings, update }: SectionProps) {
  return (
    <>
      <ToggleSetting name="briefEnabled" settings={settings} update={update} />
      <SettingRow label="Brief time" hint="If the PC is off then, it comes when you are back, before noon or within two hours.">
        <input
          type="time"
          className="field-input setting-select"
          value={settings.briefTime}
          aria-label="Time of the morning brief"
          disabled={!settings.briefEnabled}
          onChange={(e) => {
            // An empty value is a half-typed time; the browser only reports a whole HH:MM.
            if (e.target.value) void update({ briefTime: e.target.value });
          }}
        />
      </SettingRow>
      <ToggleSetting name="briefWeekdaysOnly" settings={settings} update={update} disabled={!settings.briefEnabled} />
    </>
  );
}
