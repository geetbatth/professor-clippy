/**
 * "Is another app fullscreen?" detection, for `hideOnFullscreen`.
 *
 * Electron has no API for this, so on Windows a hidden PowerShell child polls
 * `SHQueryUserNotificationState` (the same signal Windows uses to hold back toasts
 * during games and presentations) and prints the state once per poll. No native module.
 */
import { spawn, type ChildProcess } from 'node:child_process';

/** Starts watching; calls `onChange(fullscreen)` with every reading. `stop()` ends it. */
export interface FullscreenProbe {
  start(onReading: (fullscreen: boolean) => void): void;
  stop(): void;
}

/**
 * QUERY_USER_NOTIFICATION_STATE values that mean a fullscreen app owns the screen:
 * 2 QUNS_BUSY (fullscreen app or presentation settings), 3 QUNS_RUNNING_D3D_FULL_SCREEN,
 * 4 QUNS_PRESENTATION_MODE. Everything else (1 locked, 5 normal, 6 quiet time, 7 app) is not.
 */
const FULLSCREEN_STATES = new Set([2, 3, 4]);

/** Parse one line of probe output; `undefined` for noise. */
export function parseNotificationState(line: string): boolean | undefined {
  const trimmed = line.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return FULLSCREEN_STATES.has(Number(trimmed));
}

/** PowerShell loop: print the state every `intervalMs`; exit when the parent process is gone. */
export function probeScript(parentPid: number, intervalMs: number): string {
  return [
    `$sig = '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);'`,
    `$q = Add-Type -MemberDefinition $sig -Name Quns -Namespace ClippyProbe -PassThru`,
    `while ($true) {`,
    `  if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }`,
    `  $s = 0`,
    `  [void]$q::SHQueryUserNotificationState([ref]$s)`,
    `  [Console]::Out.WriteLine($s)`,
    `  [Console]::Out.Flush()`,
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    `}`,
  ].join('\n');
}

/** The Windows probe. On other platforms it never reports fullscreen. */
export function windowsFullscreenProbe(intervalMs = 1500): FullscreenProbe {
  let child: ChildProcess | undefined;
  return {
    start(onReading) {
      if (process.platform !== 'win32' || child) return;
      const encoded = Buffer.from(probeScript(process.pid, intervalMs), 'utf16le').toString('base64');
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      );
      let buffered = '';
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        buffered += chunk;
        const lines = buffered.split(/\r?\n/);
        buffered = lines.pop() ?? '';
        for (const line of lines) {
          const reading = parseNotificationState(line);
          if (reading !== undefined) onReading(reading);
        }
      });
      // A missing/broken PowerShell just means no fullscreen hiding.
      child.on('error', () => {
        child = undefined;
      });
      child.on('exit', () => {
        child = undefined;
      });
    },
    stop() {
      child?.kill();
      child = undefined;
    },
  };
}

/**
 * Decides when to hide/show for a stream of fullscreen readings. It only re-shows
 * a window it hid itself, and re-reads `enabled()` on every reading so toggling the
 * setting takes effect at the next poll.
 */
export function createFullscreenGate(opts: {
  enabled: () => boolean;
  hide: () => void;
  show: () => void;
}): (fullscreen: boolean) => void {
  let hiddenByUs = false;
  return (fullscreen) => {
    const shouldHide = fullscreen && opts.enabled();
    if (shouldHide && !hiddenByUs) {
      hiddenByUs = true;
      opts.hide();
    } else if (!shouldHide && hiddenByUs) {
      hiddenByUs = false;
      opts.show();
    }
  };
}
