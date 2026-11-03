/**
 * What power actions do to the machine, behind one injectable interface so tests never touch a
 * real process: list windowed apps, look processes up by exe name, terminate, relaunch, and
 * schedule or abort a Windows restart.
 *
 * The Windows implementation runs PowerShell (`-NoProfile -NonInteractive -EncodedCommand`) and
 * `shutdown.exe` from `%SystemRoot%\System32` with `execFile`, never through a shell. The scripts
 * are constants; the one piece of user input (the exe name) is validated and handed over in the
 * `CLIPPY_POWER_TARGET` environment variable, never pasted into the script.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn, type ExecFileOptions, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { OpenApp } from '@clippy/shared';
import { z } from 'zod';

/** One running process, as `Win32_Process` describes it. */
export interface ProcessInfo {
  pid: number;
  parentPid: number;
  /** Exe name, e.g. `chrome.exe`. */
  name: string;
  /** Full exe path; null when Windows won't say (an elevated or system process). */
  executablePath: string | null;
  /** Full command line (argv0 included); null when Windows won't say. */
  commandLine: string | null;
  /** The exe's file description, e.g. `Google Chrome`. */
  description?: string | undefined;
  /** Its main window's title, if it has a window. */
  windowTitle?: string | undefined;
}

/** Tailscale on this PC: is it installed, is its Windows service running, and its backend state. */
export interface TailscaleStatus {
  installed: boolean;
  /** The `Tailscale` Windows service. */
  service: 'running' | 'stopped' | 'starting' | 'missing' | 'other';
  /** `BackendState` from `tailscale status --json` (Running, Stopped, NeedsLogin, Starting, NoState), when it answered. */
  backend?: string | undefined;
}

/** Starting the service: done, or Windows is showing an admin (UAC) prompt on the desk. */
export type ServiceStart = 'started' | 'needs-approval';

export interface PowerExecutor {
  /** Running processes that have a main window. */
  listOpenApps(): Promise<OpenApp[]>;
  /** Every process whose exe name is `exe` (e.g. `chrome.exe`, case-insensitive). */
  findProcesses(exe: string): Promise<ProcessInfo[]>;
  /** Terminate one process (Windows `TerminateProcess`). Throws like `process.kill` (`ESRCH`: already gone). */
  kill(pid: number): void;
  /** Start `exePath` with `args` (the verbatim rest of a command line), detached from Clippy. */
  launch(exePath: string, args: string): Promise<void>;
  /** Schedule a restart of the PC in `delayS` seconds with a short reason Windows shows. */
  scheduleRestart(delayS: number, message: string): Promise<void>;
  /** Abort a scheduled restart. */
  abortRestart(): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Tailscale's state (never throws for a missing install: `installed: false`). */
  tailscaleStatus(): Promise<TailscaleStatus>;
  /** `tailscale up` / `tailscale down` (no admin needed for the signed-in user). */
  tailscaleCli(command: 'up' | 'down'): Promise<void>;
  /** Start the `Tailscale` Windows service; without admin rights, ask Windows to elevate (a UAC prompt on the desk). */
  startTailscaleService(): Promise<ServiceStart>;
  /** Clippy's own process; it and its children are never restarted. */
  readonly self: { pid: number; exePath: string };
}

/** Exe names a lookup accepts (the shared `AppName` rule plus `.exe`); checked again here. */
const EXE_NAME = /^[\w .()+-]{1,100}\.exe$/i;

/** Used when no executor is wired (tests, other platforms): every action fails, nothing runs. */
export const unavailableExecutor: PowerExecutor = {
  listOpenApps: () => Promise.reject(new Error('PC control is not available here')),
  findProcesses: () => Promise.reject(new Error('PC control is not available here')),
  kill: () => {
    throw new Error('PC control is not available here');
  },
  launch: () => Promise.reject(new Error('PC control is not available here')),
  scheduleRestart: () => Promise.reject(new Error('PC control is not available here')),
  abortRestart: () => Promise.reject(new Error('PC control is not available here')),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  tailscaleStatus: () => Promise.reject(new Error('PC control is not available here')),
  tailscaleCli: () => Promise.reject(new Error('PC control is not available here')),
  startTailscaleService: () => Promise.reject(new Error('PC control is not available here')),
  self: { pid: process.pid, exePath: process.execPath },
};

// ---- the Windows implementation --------------------------------------------

/** UTF-8 out (window titles are often not ASCII), no BOM. */
const PS_PREAMBLE = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
`;

/** Windowed processes as `[{ name, pid, title }]`. */
export const LIST_APPS_SCRIPT = `${PS_PREAMBLE}$apps = @(Get-Process -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0 | ForEach-Object {
  [pscustomobject]@{ name = $_.ProcessName; pid = [int]$_.Id; title = [string]$_.MainWindowTitle }
})
ConvertTo-Json -InputObject $apps -Compress
`;

/** Processes named `$env:CLIPPY_POWER_TARGET`, with parent, path, command line, description and window title. */
export const FIND_PROCESSES_SCRIPT = `${PS_PREAMBLE}$name = $env:CLIPPY_POWER_TARGET
$titles = @{}
foreach ($p in @(Get-Process -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)) { $titles[[int]$p.Id] = [string]$p.MainWindowTitle }
$descriptions = @{}
$found = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -ieq $name } | ForEach-Object {
  $path = $_.ExecutablePath
  $description = $null
  if ($path) {
    if (-not $descriptions.ContainsKey($path)) {
      try { $descriptions[$path] = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileDescription } catch { $descriptions[$path] = $null }
    }
    $description = $descriptions[$path]
  }
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    parentPid = [int]$_.ParentProcessId
    name = [string]$_.Name
    executablePath = $path
    commandLine = $_.CommandLine
    description = $description
    windowTitle = $titles[[int]$_.ProcessId]
  }
})
ConvertTo-Json -InputObject $found -Compress
`;

const optionalText = z
  .string()
  .nullish()
  .transform((s) => (s ? s : undefined));
const RawProcess = z.object({
  pid: z.number().int(),
  parentPid: z.number().int(),
  name: z.string(),
  executablePath: z.string().nullish().transform((s) => s || null),
  commandLine: z.string().nullish().transform((s) => s || null),
  description: optionalText,
  windowTitle: optionalText,
});
const RawApp = OpenApp.extend({ title: z.string().nullish().transform((s) => s ?? '') });

/** Parse PowerShell's `ConvertTo-Json` of an array (a lone object or nothing at all is tolerated). */
export function parseJsonArray<T>(stdout: string, item: z.ZodType<T>): T[] {
  const text = stdout.replace(/^\uFEFF/, '').trim();
  if (!text) return [];
  const json: unknown = JSON.parse(text);
  return z.array(item).parse(Array.isArray(json) ? json : [json]);
}

type ExecFileFn = (file: string, args: readonly string[], options: ExecFileOptions) => Promise<{ stdout: string | Buffer }>;
type SpawnFn = (file: string, args: readonly string[], options: SpawnOptions) => {
  once(event: 'spawn', cb: () => void): unknown;
  once(event: 'error', cb: (err: Error) => void): unknown;
  unref(): void;
};

export interface WindowsExecutorDeps {
  /** Default: `child_process.execFile`, promisified. */
  execFile?: ExecFileFn;
  /** Default: `child_process.spawn`. */
  spawn?: SpawnFn;
  /** Default: `process.kill(pid)` (TerminateProcess on Windows). */
  kill?: (pid: number) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Default: `process.env` (for `SystemRoot`, and the environment a relaunched app gets). */
  env?: NodeJS.ProcessEnv;
  /** Default: this process. */
  self?: { pid: number; exePath: string };
  /** Default: `fs.existsSync` (is Tailscale installed?). */
  fileExists?: (path: string) => boolean;
}

/** Longest a PowerShell lookup may take. */
const PS_TIMEOUT_MS = 20_000;
/** Longest `tailscale up` / `down` may take. */
const TAILSCALE_TIMEOUT_MS = 30_000;

/** Ask Windows to start the Tailscale service elevated (a UAC prompt on the desk). Fixed script, no input. */
export const ELEVATE_TAILSCALE_SCRIPT = `${PS_PREAMBLE}Start-Process -FilePath (Join-Path (Join-Path $env:SystemRoot 'System32') 'sc.exe') -ArgumentList 'start','Tailscale' -Verb RunAs -WindowStyle Hidden
`;

/** `sc query` output → the service state. */
export function parseServiceState(stdout: string): TailscaleStatus['service'] {
  const state = /STATE\s*:\s*\d+\s+(\w+)/.exec(stdout)?.[1]?.toUpperCase();
  if (state === 'RUNNING') return 'running';
  if (state === 'STOPPED') return 'stopped';
  if (state === 'START_PENDING') return 'starting';
  return 'other';
}

/** `tailscale status --json` output → its BackendState, if it parses. */
export function parseBackendState(stdout: string): string | undefined {
  try {
    const json: unknown = JSON.parse(stdout.replace(/^﻿/, '').trim());
    const state = (json as { BackendState?: unknown }).BackendState;
    return typeof state === 'string' ? state : undefined;
  } catch {
    return undefined;
  }
}

/** The text of a failed `execFile` (its stdout and message). */
const failureText = (err: unknown) => `${String((err as { stdout?: unknown }).stdout ?? '')} ${err instanceof Error ? err.message : String(err)}`;

export function createWindowsExecutor(deps: WindowsExecutorDeps = {}): PowerExecutor {
  const execFile: ExecFileFn = deps.execFile ?? (promisify(nodeExecFile) as unknown as ExecFileFn);
  const spawn: SpawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const env = deps.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const shutdown = join(systemRoot, 'System32', 'shutdown.exe');
  const sc = join(systemRoot, 'System32', 'sc.exe');
  const tailscale = join(env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
  const fileExists = deps.fileExists ?? existsSync;

  const runPowerShell = async (script: string, extraEnv: Record<string, string> = {}): Promise<string> => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const { stdout } = await execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      windowsHide: true,
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return String(stdout);
  };

  return {
    async listOpenApps() {
      return parseJsonArray(await runPowerShell(LIST_APPS_SCRIPT), RawApp);
    },
    async findProcesses(exe) {
      if (!EXE_NAME.test(exe)) throw new Error(`Not an exe name: ${exe}`);
      return parseJsonArray(await runPowerShell(FIND_PROCESSES_SCRIPT, { CLIPPY_POWER_TARGET: exe }), RawProcess);
    },
    kill: deps.kill ?? ((pid) => process.kill(pid)),
    launch(exePath, args) {
      return new Promise<void>((resolve, reject) => {
        // Verbatim: the rest of the original command line goes back exactly as it was, after the
        // quoted exe path (argv0), the way Windows itself would have started it.
        const child = spawn(exePath, args ? [args] : [], {
          detached: true,
          stdio: 'ignore',
          windowsVerbatimArguments: true,
          argv0: `"${exePath}"`,
          cwd: dirname(exePath),
          env: appEnv(env),
        });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
    },
    async scheduleRestart(delayS, message) {
      await execFile(shutdown, ['/r', '/t', String(delayS), '/c', message], { windowsHide: true, timeout: PS_TIMEOUT_MS });
    },
    async abortRestart() {
      await execFile(shutdown, ['/a'], { windowsHide: true, timeout: PS_TIMEOUT_MS });
    },
    sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
    async tailscaleStatus() {
      if (!fileExists(tailscale)) return { installed: false, service: 'missing' };
      let service: TailscaleStatus['service'];
      try {
        service = parseServiceState(String((await execFile(sc, ['query', 'Tailscale'], { windowsHide: true, timeout: PS_TIMEOUT_MS })).stdout));
      } catch (err) {
        // 1060: the service does not exist.
        service = /\b1060\b/.test(failureText(err)) ? 'missing' : 'other';
      }
      let backend: string | undefined;
      try {
        backend = parseBackendState(String((await execFile(tailscale, ['status', '--json'], { windowsHide: true, timeout: PS_TIMEOUT_MS })).stdout));
      } catch (err) {
        // `tailscale status` exits non-zero while stopped but still prints the JSON.
        backend = parseBackendState(String((err as { stdout?: unknown }).stdout ?? ''));
      }
      return { installed: true, service, backend };
    },
    async tailscaleCli(command) {
      await execFile(tailscale, [command], { windowsHide: true, timeout: TAILSCALE_TIMEOUT_MS });
    },
    async startTailscaleService() {
      try {
        await execFile(sc, ['start', 'Tailscale'], { windowsHide: true, timeout: PS_TIMEOUT_MS });
        return 'started';
      } catch (err) {
        const text = failureText(err);
        if (/\b1056\b/.test(text)) return 'started'; // already running
        if (!/FAILED 5\b|Access is denied/i.test(text)) throw new Error(`sc start Tailscale failed: ${text.trim()}`);
      }
      // No admin rights: let Windows ask (UAC). Detached, so a prompt nobody answers holds nothing up.
      await new Promise<void>((resolve, reject) => {
        const encoded = Buffer.from(ELEVATE_TAILSCALE_SCRIPT, 'utf16le').toString('base64');
        const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
          env,
        });
        child.once('error', reject);
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return 'needs-approval';
    },
    self: deps.self ?? { pid: process.pid, exePath: process.execPath },
  };
}

/** Clippy's environment minus its own and Electron's variables (`ELECTRON_RUN_AS_NODE` would break an Electron app). */
export function appEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ELECTRON_|CLIPPY_)/i.test(key)));
}
