/**
 * Which backend the renderer uses. The mock is only for `?mock=1` or a dev build with no
 * preload; a production renderer without the preload bridge reports it as missing.
 */
export type BackendChoice = 'real' | 'mock' | 'missing';

/** Pure decision, unit-tested. */
export function chooseBackend(opts: { search: string; hasPreload: boolean; dev: boolean }): BackendChoice {
  if (new URLSearchParams(opts.search).get('mock') === '1') return 'mock';
  if (opts.hasPreload) return 'real';
  return opts.dev ? 'mock' : 'missing';
}
