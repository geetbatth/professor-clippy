import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// Some hosts (T3 Code, VS Code terminals) export ELECTRON_RUN_AS_NODE=1, which would make
// `electron-vite dev`/`preview` start Electron as plain Node. Electron is spawned from this
// process with its env, so clear the flag here.
delete process.env.ELECTRON_RUN_AS_NODE;

// @clippy/shared ships TypeScript source, so it must be bundled, not externalized.
const bundleShared = { exclude: ['@clippy/shared'] };

export default defineConfig({
  main: {
    build: { externalizeDeps: bundleShared },
  },
  preload: {
    build: {
      externalizeDeps: bundleShared,
      // Sandboxed preload scripts must be CommonJS.
      rolldownOptions: { output: { format: 'cjs' } },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
