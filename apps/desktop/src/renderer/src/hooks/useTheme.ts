import { useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Settings } from '@clippy/shared/settings';
import { resolveTheme } from '@clippy/shared/theme';
import { themeAttrs } from '../theme';

/**
 * Paints the chosen theme on `<html>` (`data-theme`, `data-dark`; see `styles/theme.css`).
 * With "Follow Windows dark mode" on, it switches the moment Windows does (`theme:system`).
 * Until settings load the page stays classic, the CSS default.
 *
 * The brain's `set_look` changes the settings behind the window's back, so they are re-read
 * whenever the brain finishes a turn.
 */
export function useTheme(api: ClippyWindowApi, settings: Settings | undefined, refreshSettings: () => void): void {
  const [systemDark, setSystemDark] = useState(false);

  useEffect(() => {
    let live = true;
    void api.systemDark().then((dark) => live && setSystemDark(dark), () => {});
    const off = api.on('theme:system', setSystemDark);
    return () => {
      live = false;
      off();
    };
  }, [api]);

  useEffect(() => api.on('brain:state', (state) => state === 'idle' && refreshSettings()), [api, refreshSettings]);

  const theme = settings?.theme;
  const followSystemDark = settings?.followSystemDark;
  const darkTheme = settings?.darkTheme;
  useEffect(() => {
    if (theme === undefined || followSystemDark === undefined || darkTheme === undefined) return;
    const attrs = themeAttrs(resolveTheme({ theme, followSystemDark, darkTheme }, systemDark));
    document.documentElement.dataset.theme = attrs.theme;
    document.documentElement.dataset.dark = attrs.dark;
  }, [theme, followSystemDark, darkTheme, systemDark]);
}
