/**
 * Which `<html>` attributes paint a theme: `data-theme` picks the colour tokens in
 * `styles/theme.css`, `data-dark` switches on what only dark themes need (Clippy's rim light).
 */
import { ThemeId, THEMES } from '@clippy/shared/theme';

export interface ThemeAttrs {
  theme: ThemeId;
  dark: 'true' | 'false';
}

export function themeAttrs(theme: ThemeId): ThemeAttrs {
  const info = THEMES.find((t) => t.id === theme);
  return { theme, dark: info?.dark ? 'true' : 'false' };
}

/**
 * The theme in the URL (`?theme=<id>`): main passes the one to paint to a page window, and the
 * browser preview takes one too. Undefined if there is none, or it is not a theme.
 */
export function themeFromSearch(search: string): ThemeAttrs | undefined {
  const theme = ThemeId.safeParse(new URLSearchParams(search).get('theme'));
  return theme.success ? themeAttrs(theme.data) : undefined;
}
