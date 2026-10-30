import { describe, expect, it } from 'vitest';
import { DarkThemeId, PAGE_COLORS, PageColor, resolveTheme, THEMES, ThemeId } from '../src/theme';

describe('THEMES', () => {
  it('lists the seven themes in order', () => {
    expect(THEMES.map((t) => t.id)).toEqual(['classic', 'mint', 'blush', 'sky', 'peach', 'night', 'chalkboard']);
  });

  it('marks only night and chalkboard as dark', () => {
    expect(THEMES.filter((t) => t.dark).map((t) => t.id)).toEqual(['night', 'chalkboard']);
  });

  it('gives every theme a label and a swatch colour', () => {
    for (const t of THEMES) {
      expect(t.label).not.toBe('');
      expect(t.swatch).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('accepts exactly those ids, and only the dark ones as a dark theme', () => {
    expect(ThemeId.safeParse('mint').success).toBe(true);
    expect(ThemeId.safeParse('neon').success).toBe(false);
    expect(DarkThemeId.safeParse('chalkboard').success).toBe(true);
    expect(DarkThemeId.safeParse('mint').success).toBe(false);
  });
});

describe('PAGE_COLORS', () => {
  it('offers yellow plus the four pastel papers', () => {
    expect(PAGE_COLORS.map((c) => c.id)).toEqual(['yellow', 'mint', 'blush', 'sky', 'peach']);
    expect(PageColor.safeParse('peach').success).toBe(true);
    expect(PageColor.safeParse('night').success).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('uses the chosen theme when not following Windows', () => {
    expect(resolveTheme({ theme: 'mint', followSystemDark: false, darkTheme: 'night' }, true)).toBe('mint');
  });

  it('uses the dark theme when following and Windows is dark', () => {
    expect(resolveTheme({ theme: 'mint', followSystemDark: true, darkTheme: 'chalkboard' }, true)).toBe('chalkboard');
  });

  it('uses the chosen theme when following and Windows is light', () => {
    expect(resolveTheme({ theme: 'mint', followSystemDark: true, darkTheme: 'chalkboard' }, false)).toBe('mint');
  });
});
