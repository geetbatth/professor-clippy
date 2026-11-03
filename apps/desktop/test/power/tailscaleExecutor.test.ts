/**
 * The Windows executor's Tailscale commands with execFile and spawn faked: these check the exact
 * commands (sc.exe, tailscale.exe, the elevated PowerShell) and never run anything for real.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createWindowsExecutor, ELEVATE_TAILSCALE_SCRIPT, parseBackendState, parseServiceState } from '../../src/main/power/executor';

const SC = 'C:\\WINDOWS\\System32\\sc.exe';
const TS = 'C:\\Program Files\\Tailscale\\tailscale.exe';

const RUNNING = `
SERVICE_NAME: Tailscale
        TYPE               : 10  WIN32_OWN_PROCESS
        STATE              : 4  RUNNING
                                (STOPPABLE, NOT_PAUSABLE, ACCEPTS_SHUTDOWN)
`;
const STOPPED = RUNNING.replace('4  RUNNING', '1  STOPPED');

/** A failed execFile, the way Node rejects it (stdout attached). */
const failure = (message: string, stdout = '') => Object.assign(new Error(message), { stdout });

type Reply = string | Error;

function setup(replies: Record<string, Reply>, installed = true) {
  const execs: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const spawns: { file: string; args: readonly string[]; options: Record<string, unknown> }[] = [];
  const executor = createWindowsExecutor({
    env: { SystemRoot: 'C:\\WINDOWS', ProgramFiles: 'C:\\Program Files' },
    self: { pid: 1, exePath: 'C:\\Clippy.exe' },
    fileExists: (path) => installed && path === TS,
    execFile: async (file, args, options) => {
      execs.push({ file, args, options: options as Record<string, unknown> });
      const reply = replies[`${file} ${args.join(' ')}`];
      if (reply === undefined) throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
      if (reply instanceof Error) throw reply;
      return { stdout: reply };
    },
    spawn: (file, args, options) => {
      spawns.push({ file, args, options: options as Record<string, unknown> });
      const child = Object.assign(new EventEmitter(), { unref: () => undefined });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });
  return { executor, execs, spawns };
}

describe('Windows executor: Tailscale', () => {
  it('reports not installed without running anything', async () => {
    const { executor, execs } = setup({}, false);
    await expect(executor.tailscaleStatus()).resolves.toEqual({ installed: false, service: 'missing' });
    expect(execs).toEqual([]);
  });

  it('reads the service from sc.exe and the backend from tailscale status --json', async () => {
    const { executor } = setup({
      [`${SC} query Tailscale`]: RUNNING,
      [`${TS} status --json`]: '{"BackendState":"Running","Self":{}}',
    });
    await expect(executor.tailscaleStatus()).resolves.toEqual({ installed: true, service: 'running', backend: 'Running' });
  });

  it('reads the JSON tailscale prints even when it exits non-zero (stopped)', async () => {
    const { executor } = setup({
      [`${SC} query Tailscale`]: RUNNING,
      [`${TS} status --json`]: failure('Command failed', '{"BackendState":"Stopped"}'),
    });
    await expect(executor.tailscaleStatus()).resolves.toEqual({ installed: true, service: 'running', backend: 'Stopped' });
  });

  it('a stopped service has no backend to ask', async () => {
    const { executor } = setup({
      [`${SC} query Tailscale`]: STOPPED,
      [`${TS} status --json`]: failure('failed to connect to local tailscaled'),
    });
    await expect(executor.tailscaleStatus()).resolves.toEqual({ installed: true, service: 'stopped', backend: undefined });
  });

  it('a missing service (1060) is missing', async () => {
    const { executor } = setup({
      [`${SC} query Tailscale`]: failure('Command failed', '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:'),
      [`${TS} status --json`]: failure('nope'),
    });
    await expect(executor.tailscaleStatus()).resolves.toMatchObject({ service: 'missing' });
  });

  it('runs tailscale up and down directly, hidden, with a timeout', async () => {
    const { executor, execs } = setup({ [`${TS} up`]: '', [`${TS} down`]: '' });
    await executor.tailscaleCli('down');
    await executor.tailscaleCli('up');
    expect(execs.map((e) => e.args)).toEqual([['down'], ['up']]);
    expect(execs[0]!.options).toMatchObject({ windowsHide: true, timeout: 30_000 });
  });

  it('starts the service with sc.exe when allowed', async () => {
    const { executor, spawns } = setup({ [`${SC} start Tailscale`]: '' });
    await expect(executor.startTailscaleService()).resolves.toBe('started');
    expect(spawns).toEqual([]);
  });

  it('already running (1056) counts as started', async () => {
    const { executor } = setup({ [`${SC} start Tailscale`]: failure('Command failed', '[SC] StartService FAILED 1056:') });
    await expect(executor.startTailscaleService()).resolves.toBe('started');
  });

  it('access denied asks Windows to elevate: a detached, hidden PowerShell with a fixed script', async () => {
    const { executor, spawns } = setup({ [`${SC} start Tailscale`]: failure('Command failed', '[SC] StartService: OpenService FAILED 5:\n\nAccess is denied.') });
    await expect(executor.startTailscaleService()).resolves.toBe('needs-approval');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.file).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(spawns[0]!.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect(Buffer.from(String(spawns[0]!.args.at(-1)), 'base64').toString('utf16le')).toBe(ELEVATE_TAILSCALE_SCRIPT);
    expect(ELEVATE_TAILSCALE_SCRIPT).toContain("-ArgumentList 'start','Tailscale' -Verb RunAs");
  });

  it('any other sc failure is an error', async () => {
    const { executor, spawns } = setup({ [`${SC} start Tailscale`]: failure('Command failed', '[SC] StartService FAILED 1058:') });
    await expect(executor.startTailscaleService()).rejects.toThrow(/sc start Tailscale failed/);
    expect(spawns).toEqual([]);
  });
});

describe('Tailscale parsers', () => {
  it('parseServiceState', () => {
    expect(parseServiceState(RUNNING)).toBe('running');
    expect(parseServiceState(STOPPED)).toBe('stopped');
    expect(parseServiceState(RUNNING.replace('4  RUNNING', '2  START_PENDING'))).toBe('starting');
    expect(parseServiceState('')).toBe('other');
  });

  it('parseBackendState', () => {
    expect(parseBackendState('\uFEFF{"BackendState":"NeedsLogin"}')).toBe('NeedsLogin');
    expect(parseBackendState('not json')).toBeUndefined();
    expect(parseBackendState('{}')).toBeUndefined();
  });
});
