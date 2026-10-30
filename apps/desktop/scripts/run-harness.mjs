// Build and launch the Clippy window dev harness (src/main/window/dev/harness.ts): the real
// window + preload + IPC, with the mock backend standing in for the app's main process.
//
//   npm run build -w apps/desktop                      # preload + renderer
//   node apps/desktop/scripts/run-harness.mjs          # try it (drag, click, chat...)
//   node apps/desktop/scripts/run-harness.mjs --capture=docs/screenshots/raw
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { build } from 'vite';

const root = join(import.meta.dirname, '..');
await build({
  root,
  logLevel: 'warn',
  configFile: false,
  build: {
    ssr: join(root, 'src/main/window/dev/harness.ts'),
    outDir: join(root, 'out/harness'),
    emptyOutDir: true,
    rolldownOptions: { output: { format: 'es', entryFileNames: 'harness.js' } },
  },
  ssr: { noExternal: true, external: ['electron'] },
});

const electronPath = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // some hosts set it; it would turn Electron into plain Node
const result = spawnSync(electronPath, [join(root, 'out/harness/harness.js'), ...process.argv.slice(2)], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
