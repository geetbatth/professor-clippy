import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PAGE_COLORS, THEMES } from '@clippy/shared/theme';
import { themeAttrs } from '../../src/renderer/src/theme';

/** The tokens later screens rely on: every theme must define each of them. */
const REQUIRED_TOKENS = [
  '--paper-1',
  '--paper-2',
  '--paper-curl',
  '--paper-shine',
  '--ink',
  '--ink-soft',
  '--ink-faint',
  '--head',
  '--line',
  '--card',
  '--card-border',
  '--tab-on',
  '--accent',
  '--btn',
  '--btn-ink',
  '--field',
  '--field-border',
  '--bubble',
  '--bubble-ink',
  '--bubble-border',
  '--ok',
  '--bad',
  '--badge',
];

const css = readFileSync(new URL('../../src/renderer/src/styles/theme.css', import.meta.url), 'utf8');

/** The declarations of `:root[data-theme="<id>"] { ... }` as token -> value. */
function block(id: string): Map<string, string> {
  // The selector list may go on with the page colour that shares the block.
  const match = new RegExp(`:root\\[data-theme="${id}"\\][^{]*\\{([^}]*)\\}`).exec(css);
  expect(match, `theme.css has no block for ${id}`).not.toBeNull();
  const tokens = new Map<string, string>();
  for (const [, name, value] of match![1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens.set(name!, value!.trim());
  return tokens;
}

describe('themeAttrs', () => {
  it('names the theme and says whether it is dark, as the strings the html attributes take', () => {
    expect(themeAttrs('night')).toEqual({ theme: 'night', dark: 'true' });
    expect(themeAttrs('chalkboard')).toEqual({ theme: 'chalkboard', dark: 'true' });
    expect(themeAttrs('classic')).toEqual({ theme: 'classic', dark: 'false' });
    expect(themeAttrs('mint')).toEqual({ theme: 'mint', dark: 'false' });
  });
});

describe('theme.css', () => {
  it.each(THEMES.map((t) => t.id))('%s defines every required token', (id) => {
    const tokens = block(id);
    for (const name of REQUIRED_TOKENS) expect(tokens.has(name), `${id} lacks ${name}`).toBe(true);
  });

  it('gives every theme the same set of tokens', () => {
    const classic = [...block('classic').keys()].sort();
    for (const t of THEMES) expect([...block(t.id).keys()].sort(), t.id).toEqual(classic);
  });

  it('paints each theme paper with the colour its swatch shows', () => {
    for (const t of THEMES) expect(block(t.id).get('--paper-1'), t.id).toBe(t.swatch);
  });

  it('keeps classic as the original sticky note yellow and ink', () => {
    const classic = block('classic');
    expect(classic.get('--paper-1')).toBe('#fff58a');
    expect(classic.get('--paper-2')).toBe('#ffe766');
    expect(classic.get('--ink')).toBe('#4a3d12');
  });

  it('paints a coloured page with the light theme of that paper (yellow is classic)', () => {
    for (const c of PAGE_COLORS) {
      const theme = c.id === 'yellow' ? 'classic' : c.id;
      expect(css, c.id).toMatch(new RegExp(`:root\\[data-theme="${theme}"\\],\\s*\\[data-page-color="${c.id}"\\]\\s*\\{`));
      expect(block(theme).get('--paper-1'), c.id).toBe(c.swatch);
    }
  });

  it('uses classic when no theme is set yet', () => {
    expect(css).toMatch(/:root,\s*:root\[data-theme="classic"\]/);
  });

  it('gives Clippy a rim light on dark themes only', () => {
    expect(css).toMatch(/:root\[data-dark="true"\] \.clippy-sprite\s*\{\s*filter: drop-shadow\(0 0 6px rgba\(255, 255, 255, 0\.35\)\);/);
  });
});
