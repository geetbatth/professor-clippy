import { defineConfig } from 'vite';

// Bundle into one self-contained ESM file (dist/index.js) runnable with plain `node`,
// including @clippy/shared (TypeScript source) and all npm dependencies.
export default defineConfig({
  build: {
    ssr: 'src/index.ts',
    target: 'node22',
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: { output: { format: 'es', entryFileNames: 'index.js' } },
  },
  ssr: { target: 'node', noExternal: true },
});
