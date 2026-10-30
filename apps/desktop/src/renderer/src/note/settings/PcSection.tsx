import { useEffect, useState } from 'react';
import type { HotkeyStatus } from '@clippy/shared/ipc';
// The app's version is the desktop package's (what Electron's `app.getVersion()` reports too).
import { version } from '../../../../../package.json';
import { SettingRow, ToggleSetting, type SectionProps } from './controls';

/** Settings → Windows & hotkeys: the Tell Clippy hotkey, starting with Windows, restarts, the welcome, the version. */
export function PcSection({ api, settings, update }: SectionProps) {
  const [hotkey, setHotkey] = useState(settings.tellHotkey);
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>();

  // Main registers the shortcut when the setting changes; ask how that went.
  useEffect(() => {
    let live = true;
    setHotkey(settings.tellHotkey);
    void api.hotkeyStatus().then((s) => live && setHotkeyStatus(s), () => {});
    return () => {
      live = false;
    };
  }, [api, settings.tellHotkey]);

  /** Save the hotkey on blur / Enter if it changed. Anything goes in: main reports a bad one. */
  const commitHotkey = () => {
    const accelerator = hotkey.trim();
    setHotkey(accelerator);
    if (accelerator !== settings.tellHotkey) void update({ tellHotkey: accelerator });
  };

  return (
    <>
      <SettingRow label="Tell Clippy hotkey" hint="Press it anywhere to type him an instruction. Empty = no hotkey.">
        <input
          type="text"
          className={`field-input setting-select${hotkeyStatus && !hotkeyStatus.ok ? ' field-input--bad' : ''}`}
          value={hotkey}
          maxLength={60}
          placeholder="Control+Alt+Space"
          aria-label="Tell Clippy hotkey"
          aria-invalid={hotkeyStatus ? !hotkeyStatus.ok : false}
          onChange={(e) => setHotkey(e.target.value)}
          onBlur={commitHotkey}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHotkey();
            if (e.key === 'Escape') setHotkey(settings.tellHotkey);
          }}
        />
      </SettingRow>
      {hotkeyStatus && !hotkeyStatus.ok && <p className="card-error">{hotkeyStatus.error}</p>}
      {hotkeyStatus?.ok && hotkeyStatus.accelerator && <p className="setting-hint">Ready: press {hotkeyStatus.accelerator} from anywhere.</p>}
      <ToggleSetting name="autoStart" settings={settings} update={update} />
      <ToggleSetting name="allowPowerActions" settings={settings} update={update} />
      <div className="settings-footer">
        {/* Shows the first-run setup again (the note switches to it as soon as this is saved). */}
        <button type="button" className="btn btn-option" onClick={() => void update({ firstRunDone: false })}>
          Run the welcome again
        </button>
        <span className="settings-version">Professor Clippy {version}</span>
      </div>
    </>
  );
}
