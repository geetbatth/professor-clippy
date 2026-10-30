/**
 * Professor Clippy Claude Code hook (`Stop`, `Notification` and `PermissionRequest`). Reads the
 * hook event JSON on stdin and posts a note via `ClippyClient`. It must never get in Claude Code's
 * way: it exits 0, prints nothing (except a `PermissionRequest` decision the user made), and
 * finishes within a couple of seconds (a `PermissionRequest` waits for the user while they are
 * away, up to `HOOK_WAIT_S`).
 *
 * How it stays bounded without risking a crash: stdin is read for at most
 * STDIN_LIMIT_MS, and each local API request times out after
 * REQUEST_TIMEOUT_MS (1 s), so the event loop always drains on its own and the
 * process exits with `process.exitCode = 0`. Calling `process.exit()` right
 * after a fetch completes can trip a libuv assertion on Windows
 * (`!(handle->flags & UV_HANDLE_CLOSING)`, exit code 0xC0000409), so normal
 * runs never call it. The only `process.exit` is the unref'd LAST_RESORT_MS
 * timer, which fires only if something unforeseen still holds the loop open
 * long after every request has timed out. A `PermissionRequest` re-arms it for
 * PERMISSION_LAST_RESORT_MS, still under that hook entry's 1800 s timeout.
 */
import { LAST_RESORT_MS, lastResortMs, runHook } from './hook';

const STDIN_LIMIT_MS = 1000;

process.exitCode = 0;
let lastResort = setTimeout(() => process.exit(0), LAST_RESORT_MS).unref();

function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    let raw = '';
    const finish = () => {
      clearTimeout(timer);
      process.stdin.destroy(); // stop holding the loop open if the writer never closed stdin
      resolve(raw);
    };
    const timer = setTimeout(finish, STDIN_LIMIT_MS);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

try {
  const raw = await readStdin();
  const ms = lastResortMs(raw);
  if (ms !== LAST_RESORT_MS) {
    clearTimeout(lastResort);
    lastResort = setTimeout(() => process.exit(0), ms).unref();
  }
  await runHook(raw, { write: (text) => process.stdout.write(text) });
} catch {
  // never fail the hook
}
