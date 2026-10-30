/**
 * Which `<html>` attributes paint a theme: `data-theme` picks the colour tokens in
 * `styles/theme.css`, `data-dark` switches on what only dark themes need (Clippy's rim light).
 */
import { THEMES, type ThemeId } from '@clippy/shared/theme';

export interface ThemeAttrs {
  theme: ThemeId;
  dark: 'true' | 'false';
}

export function themeAttrs(theme: ThemeId): ThemeAttrs {
  const info = THEMES.find((t) => t.id === theme);
  return { theme, dark: info?.dark ? 'true' : 'false' };
}
