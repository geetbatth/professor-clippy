/**
 * Professor Clippy Claude Code hook (`Stop` and `Notification`). Reads the hook
 * event JSON on stdin and posts a note via `ClippyClient`. It must never get
 * in Claude Code's way: it prints nothing, always exits 0, and gives up after
 * a few seconds.
 */
import { runHook } from './hook';

const HARD_LIMIT_MS = 5000;

setTimeout(() => process.exit(0), HARD_LIMIT_MS).unref();

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;
  return raw;
}

try {
  await runHook(await readStdin());
} catch {
  // never fail the hook
}
// Let the process end on its own: calling process.exit() right after a fetch
// can trip a libuv assertion on Windows (exit code 0xC0000409).
process.exitCode = 0;
