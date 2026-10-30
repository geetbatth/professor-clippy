/**
 * Colour themes for the note, and the paper colours a page can have.
 *
 * Node-free (`@clippy/shared/theme`), so the renderer can use it. The colours themselves live in
 * the renderer's `styles/theme.css` (one `:root[data-theme="<id>"]` block per theme); the
 * `swatch` here is only the little colour chip a picker shows.
 */
import { z } from 'zod';
import type { Settings } from './settings';

/** Every theme: five light ones (classic is today's yellow) and two dark ones. */
export const ThemeId = z.enum(['classic', 'mint', 'blush', 'sky', 'peach', 'night', 'chalkboard']);
export type ThemeId = z.infer<typeof ThemeId>;

/** The themes that can be picked for "follow Windows dark mode". */
export const DarkThemeId = z.enum(['night', 'chalkboard']);
export type DarkThemeId = z.infer<typeof DarkThemeId>;

/** What a pad page can be coloured (the light themes' papers). */
export const PageColor = z.enum(['yellow', 'mint', 'blush', 'sky', 'peach']);
export type PageColor = z.infer<typeof PageColor>;

export interface ThemeInfo {
  id: ThemeId;
  /** Shown in the picker. */
  label: string;
  /** A dark theme (gets Clippy's rim light and is what "follow Windows" switches to). */
  dark: boolean;
  /** The paper colour, for the picker's chip. */
  swatch: string;
}

/** The themes in picker order. */
export const THEMES: readonly ThemeInfo[] = [
  { id: 'classic', label: 'Classic yellow', dark: false, swatch: '#fff58a' },
  { id: 'mint', label: 'Mint', dark: false, swatch: '#c9f5dc' },
  { id: 'blush', label: 'Blush', dark: false, swatch: '#ffd9e6' },
  { id: 'sky', label: 'Sky', dark: false, swatch: '#d6ecff' },
  { id: 'peach', label: 'Peach', dark: false, swatch: '#ffe2c7' },
  { id: 'night', label: 'Night', dark: true, swatch: '#2b2f3a' },
  { id: 'chalkboard', label: 'Chalkboard', dark: true, swatch: '#2f4a3a' },
];

export interface PageColorInfo {
  id: PageColor;
  label: string;
  swatch: string;
}

export const PAGE_COLORS: readonly PageColorInfo[] = [
  { id: 'yellow', label: 'Yellow', swatch: '#fff58a' },
  { id: 'mint', label: 'Mint', swatch: '#c9f5dc' },
  { id: 'blush', label: 'Blush', swatch: '#ffd9e6' },
  { id: 'sky', label: 'Sky', swatch: '#d6ecff' },
  { id: 'peach', label: 'Peach', swatch: '#ffe2c7' },
];

/**
 * The theme to paint right now: the dark theme while "follow Windows dark mode" is on and Windows
 * is dark, otherwise the chosen theme.
 */
export function resolveTheme(s: Pick<Settings, 'theme' | 'followSystemDark' | 'darkTheme'>, systemDark: boolean): ThemeId {
  return s.followSystemDark && systemDark ? s.darkTheme : s.theme;
}
