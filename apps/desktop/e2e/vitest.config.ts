import { defineConfig } from 'vitest/config';

// Local end-to-end run against the built app (`npm run e2e -w apps/desktop`); not part of `npm test`.
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['**/*.e2e.ts'],
    testTimeout: 180_000,
  },
});
