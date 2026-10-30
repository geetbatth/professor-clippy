// Run a script with Electron's bundled Node (ELECTRON_RUN_AS_NODE=1), from any shell.
//   node scripts/run-in-electron.mjs <script.mjs> [args...]
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node scripts/run-in-electron.mjs <script.mjs> [args...]');
  process.exit(2);
}
// The `electron` package's main export is the path to the Electron binary.
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const electronPath = require('electron');
const result = spawnSync(electronPath, [script, ...args], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(result.status ?? 1);
