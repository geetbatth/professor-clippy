// Run a script as a real Electron main process (not as Node), from any shell.
//   node apps/desktop/scripts/launch-electron.mjs <script.mjs> [args...]
// Some hosts export ELECTRON_RUN_AS_NODE=1, which would turn Electron into plain Node; clear it.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const [script, ...args] = process.argv.slice(2);
if (!script) {
  console.error('usage: node apps/desktop/scripts/launch-electron.mjs <script.mjs> [args...]');
  process.exit(2);
}
const electronPath = createRequire(import.meta.url)('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(electronPath, [script, ...args], { stdio: 'inherit', env });
process.exit(result.status ?? 1);
