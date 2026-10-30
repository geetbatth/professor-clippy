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
}

/** Longest a PowerShell lookup may take. */
const PS_TIMEOUT_MS = 20_000;

export function createWindowsExecutor(deps: WindowsExecutorDeps = {}): PowerExecutor {
  const execFile: ExecFileFn = deps.execFile ?? (promisify(nodeExecFile) as unknown as ExecFileFn);
  const spawn: SpawnFn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const env = deps.env ?? process.env;
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const shutdown = join(systemRoot, 'System32', 'shutdown.exe');

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
    self: deps.self ?? { pid: process.pid, exePath: process.execPath },
  };
}

/** Clippy's environment minus its own and Electron's variables (`ELECTRON_RUN_AS_NODE` would break an Electron app). */
export function appEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !/^(ELECTRON_|CLIPPY_)/i.test(key)));
}
