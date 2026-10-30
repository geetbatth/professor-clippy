import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // node:sqlite prints an ExperimentalWarning under Node 24.13 (not under Electron's Node).
    execArgv: ['--disable-warning=ExperimentalWarning'],
  },
});
