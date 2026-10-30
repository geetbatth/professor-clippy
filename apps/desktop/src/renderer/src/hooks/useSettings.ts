import { useCallback, useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Settings, SettingsPatch } from '@clippy/shared/settings';

export interface SettingsState {
  /** Undefined until loaded. */
  settings: Settings | undefined;
  /** Last save error (e.g. an invalid relay URL), cleared by the next successful save. */
  error: string | undefined;
  update(patch: SettingsPatch): Promise<boolean>;
  /** Re-read from main (settings can also change from the tray). */
  refresh(): void;
}

export function useSettings(api: ClippyWindowApi): SettingsState {
  const [settings, setSettings] = useState<Settings>();
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    void api.getSettings().then(setSettings, () => {});
  }, [api]);

  useEffect(() => {
    let live = true;
    void api.getSettings().then((s) => live && setSettings(s));
    // The tray can mute sounds while the window is open; pick that up when the user comes back.
    window.addEventListener('focus', refresh);
    return () => {
      live = false;
      window.removeEventListener('focus', refresh);
    };
  }, [api, refresh]);

  const update = useCallback(
    async (patch: SettingsPatch) => {
      try {
        setSettings(await api.setSettings(patch));
        setError(undefined);
        return true;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return false;
      }
    },
    [api],
  );

  return { settings, error, update, refresh };
}
