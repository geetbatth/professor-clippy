/**
 * "Is another app fullscreen?" detection, for `hideOnFullscreen`.
 *
 * Electron and Node have no API for another app's fullscreen state (none of `screen`,
 * `powerMonitor` or `desktopCapturer` exposes the foreground window), so this asks Windows
 * directly: `SHQueryUserNotificationState`, the signal Windows itself uses to hold back toasts
 * during games, videos and presentations.
 *
 * It runs as a plainly visible PowerShell child, deliberately not disguised: a readable
 * `-Command` (no base64 `-EncodedCommand`) and no execution-policy override. It only runs
 * while the setting is on, exits by itself when Clippy's process goes away, and if it ever
 * dies the window is shown again and the probe restarts with capped backoff.
 *
 * Alternatives considered: UI Automation polling avoids the one-off C# compile, but querying
 * the focused element makes Chromium/Electron apps switch on full accessibility mode (slowing
 * every browser and VS Code); a native FFI module would be a new dependency.
 */
import { spawn } from 'node:child_process';

/** A running probe process. */
export interface ProbeHandle {
  kill(): void;
}
export interface ProbeCallbacks {
  onReading(fullscreen: boolean): void;
  /** The probe ended (crashed, failed to start, or exited). Called at most once per probe. */
  onExit(reason: string): void;
}
/** Starts one probe process. */
export type SpawnProbe = (callbacks: ProbeCallbacks) => ProbeHandle;

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

/** The probe's PowerShell, as one readable line: print the state every `intervalMs`; exit when `parentPid` is gone. */
export function probeCommand(parentPid: number, intervalMs: number): string {
  return [
    `$sig = '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);'`,
    `$q = Add-Type -MemberDefinition $sig -Name Quns -Namespace ProfessorClippy -PassThru`,
    `while ($true) { if (-not (Get-Process -Id ${parentPid} -ErrorAction SilentlyContinue)) { exit }; $s = 0; [void]$q::SHQueryUserNotificationState([ref]$s); [Console]::Out.WriteLine($s); Start-Sleep -Milliseconds ${intervalMs} }`,
  ].join('; ');
}

/** The Windows probe: a hidden-console `powershell.exe -NoProfile -NonInteractive -Command <probeCommand>`. */
export function windowsProbe(intervalMs = 1500): SpawnProbe {
  return ({ onReading, onExit }) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probeCommand(process.pid, intervalMs)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let errTail = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
      const lines = out.split(/\r?\n/);
      out = lines.pop() ?? '';
      for (const line of lines) {
        const reading = parseNotificationState(line);
        if (reading !== undefined) onReading(reading);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      errTail = (errTail + chunk).slice(-300);
    });
    let ended = false;
    const end = (reason: string) => {
      if (ended) return;
      ended = true;
      onExit(errTail.trim() ? `${reason}: ${errTail.trim()}` : reason);
    };
    child.on('error', (err) => end(err.message));
    child.on('exit', (code, signal) => end(`exited with ${code ?? signal}`));
    return { kill: () => child.kill() };
  };
}

export interface FullscreenWatcherOptions {
  spawn: SpawnProbe;
  /** Read on every reading and every sync; the probe only runs while this is true. */
  enabled: () => boolean;
  hide(): void;
  show(): void;
  log?: (message: string) => void;
  /** How often to check the setting (start/stop the probe). */
  syncEveryMs?: number;
  /** Restarts allowed in a row before giving up (until the setting is toggled). */
  maxRestarts?: number;
  /** Delay before restart attempt `n` (1-based). Default 2 s doubling, capped at 60 s. */
  backoffMs?: (attempt: number) => number;
  /** A probe that ran this long counts as healthy: its exit resets the failure count. */
  healthyAfterMs?: number;
  now?: () => number;
}

export interface FullscreenWatcher {
  start(): void;
  stop(): void;
}

/**
 * Runs the probe while `enabled()`, hides the window during fullscreen and shows it again
 * afterwards. It only ever re-shows a window it hid itself, and it shows it whenever the
 * probe dies, is stopped, or the setting is switched off, so Clippy can't get stuck hidden.
 */
export function createFullscreenWatcher(opts: FullscreenWatcherOptions): FullscreenWatcher {
  const log = opts.log ?? (() => {});
  const syncEveryMs = opts.syncEveryMs ?? 5_000;
  const maxRestarts = opts.maxRestarts ?? 5;
  const backoffMs = opts.backoffMs ?? ((n: number) => Math.min(60_000, 2_000 * 2 ** (n - 1)));
  const healthyAfterMs = opts.healthyAfterMs ?? 60_000;
  const now = opts.now ?? Date.now;

  let running = false;
  let hiddenByUs = false;
  let current: { handle?: ProbeHandle } | undefined;
  let startedAt = 0;
  let failures = 0;
  let gaveUp = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let syncTimer: ReturnType<typeof setInterval> | undefined;

  const reveal = () => {
    if (!hiddenByUs) return;
    hiddenByUs = false;
    opts.show();
  };

  const onReading = (fullscreen: boolean) => {
    if (fullscreen && opts.enabled()) {
      if (!hiddenByUs) {
        hiddenByUs = true;
        opts.hide();
      }
    } else {
      reveal();
    }
  };

  const onExit = (reason: string) => {
    reveal();
    if (!running) return;
    if (now() - startedAt >= healthyAfterMs) failures = 0;
    failures += 1;
    if (failures > maxRestarts) {
      gaveUp = true;
      log(`[clippy] fullscreen probe gave up after ${maxRestarts} restarts (${reason}); hide-on-fullscreen is off until the setting is toggled`);
      return;
    }
    const delay = backoffMs(failures);
    log(`[clippy] fullscreen probe stopped (${reason}); restarting in ${delay} ms`);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      sync();
    }, delay);
  };

  const launch = () => {
    const slot: { handle?: ProbeHandle } = {};
    current = slot;
    startedAt = now();
    try {
      slot.handle = opts.spawn({
        onReading: (fs) => {
          if (current === slot) onReading(fs);
        },
        onExit: (reason) => {
          if (current !== slot) return;
          current = undefined;
          onExit(reason);
        },
      });
    } catch (err) {
      if (current === slot) {
        current = undefined;
        onExit(err instanceof Error ? err.message : String(err));
      }
    }
  };

  const killProbe = () => {
    const slot = current;
    current = undefined;
    slot?.handle?.kill();
  };

  function sync(): void {
    if (!running) return;
    if (!opts.enabled()) {
      killProbe();
      reveal();
      // Toggling the setting off and on again earns a fresh set of retries.
      failures = 0;
      gaveUp = false;
      return;
    }
    if (!current && !retryTimer && !gaveUp) launch();
  }

  return {
    start() {
      if (running) return;
      running = true;
      sync();
      syncTimer = setInterval(sync, syncEveryMs);
    },
    stop() {
      running = false;
      clearInterval(syncTimer);
      clearTimeout(retryTimer);
      retryTimer = undefined;
      killProbe();
      reveal();
    },
  };
}
