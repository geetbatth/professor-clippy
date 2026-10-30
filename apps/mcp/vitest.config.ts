import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts on purpose: its `ssr.noExternal: true` (for the
// single-file bundle) would make Vitest inline every npm dependency.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
