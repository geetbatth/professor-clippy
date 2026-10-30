/**
 * The Windows executor with every process primitive faked: these tests check the exact commands
 * it would run, and never run PowerShell, shutdown.exe or anything else for real.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { appEnv, createWindowsExecutor, FIND_PROCESSES_SCRIPT, LIST_APPS_SCRIPT, parseJsonArray, unavailableExecutor } from '../../src/main/power/executor';
import { OpenApp } from '@clippy/shared';

interface ExecCall {
  file: string;
  args: readonly string[];
  options: Record<string, unknown>;
}

function setup(stdout = '[]') {
  const execs: ExecCall[] = [];
  const spawns: ExecCall[] = [];
  const kills: number[] = [];
  let spawnError: Error | undefined;
  const executor = createWindowsExecutor({
    env: { SystemRoot: 'C:\\WINDOWS', PATH: 'x', ELECTRON_RUN_AS_NODE: '1', CLIPPY_HOME: 'h' },
    self: { pid: 1, exePath: 'C:\\Clippy.exe' },
    execFile: async (file, args, options) => {
      execs.push({ file, args, options: options as Record<string, unknown> });
      return { stdout };
    },
    spawn: (file, args, options) => {
      spawns.push({ file, args, options: options as Record<string, unknown> });
      const child = Object.assign(new EventEmitter(), { unref: () => spawns.at(-1)!.options.unrefd = true });
      setImmediate(() => (spawnError ? child.emit('error', spawnError) : child.emit('spawn')));
      return child;
    },
    kill: (pid) => kills.push(pid),
  });
  return { executor, execs, spawns, kills, failSpawn: (e: Error) => (spawnError = e) };
}

const decode = (args: readonly string[]) => Buffer.from(String(args.at(-1)), 'base64').toString('utf16le');

describe('Windows executor (faked process primitives)', () => {
  it('lists windowed apps with PowerShell, no profile, non-interactive, script encoded', async () => {
    const { executor, execs } = setup('\uFEFF[{"name":"chrome","pid":42,"title":"Inbox"},{"name":"code","pid":7,"title":null}]');
    await expect(executor.listOpenApps()).resolves.toEqual([
      { name: 'chrome', pid: 42, title: 'Inbox' },
      { name: 'code', pid: 7, title: '' },
    ]);
    expect(execs[0]!.file).toBe('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(execs[0]!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    expect(decode(execs[0]!.args)).toBe(LIST_APPS_SCRIPT);
    expect(LIST_APPS_SCRIPT).toContain('Get-Process -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0');
    expect(execs[0]!.options).toMatchObject({ windowsHide: true });
  });

  it('looks a name up through an environment variable, never inside the script', async () => {
    const { executor, execs } = setup(
      '{"pid":5,"parentPid":4,"name":"chrome.exe","executablePath":"C:\\\\c.exe","commandLine":"c.exe --x","description":"Google Chrome","windowTitle":null}',
    );
    await expect(executor.findProcesses('chrome.exe')).resolves.toEqual([
      { pid: 5, parentPid: 4, name: 'chrome.exe', executablePath: 'C:\\c.exe', commandLine: 'c.exe --x', description: 'Google Chrome', windowTitle: undefined },
    ]);
    expect(decode(execs[0]!.args)).toBe(FIND_PROCESSES_SCRIPT);
    expect(FIND_PROCESSES_SCRIPT).not.toContain('chrome');
    expect(FIND_PROCESSES_SCRIPT).toContain('Get-CimInstance Win32_Process');
    expect(FIND_PROCESSES_SCRIPT).toContain('$env:CLIPPY_POWER_TARGET');
    expect((execs[0]!.options.env as NodeJS.ProcessEnv).CLIPPY_POWER_TARGET).toBe('chrome.exe');
  });

  it('refuses to look up something that is not an exe name', async () => {
    const { executor, execs } = setup();
    for (const bad of ['chrome', "x.exe'; calc; '.exe", 'a&b.exe']) await expect(executor.findProcesses(bad), bad).rejects.toThrow(/Not an exe name/);
    expect(execs).toEqual([]);
  });

  it('kills with the injected kill (process.kill in the app)', () => {
    const { executor, kills } = setup();
    executor.kill(1234);
    expect(kills).toEqual([1234]);
  });

  it('relaunches detached and verbatim after the quoted exe path, in its folder, without Electron or Clippy variables', async () => {
    const { executor, spawns } = setup();
    await executor.launch('C:\\Program Files\\App\\app.exe', '--a "b c"');
    expect(spawns[0]).toMatchObject({
      file: 'C:\\Program Files\\App\\app.exe',
      args: ['--a "b c"'],
      options: {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
        argv0: '"C:\\Program Files\\App\\app.exe"',
        cwd: 'C:\\Program Files\\App',
        env: { SystemRoot: 'C:\\WINDOWS', PATH: 'x' },
        unrefd: true,
      },
    });
    await executor.launch('C:\\x.exe', '');
    expect(spawns[1]!.args).toEqual([]);
  });

  it('a launch that fails rejects', async () => {
    const { executor, failSpawn } = setup();
    failSpawn(new Error('spawn ENOENT'));
    await expect(executor.launch('C:\\gone.exe', '')).rejects.toThrow('spawn ENOENT');
  });

  it('schedules and aborts a restart with System32 shutdown.exe', async () => {
    const { executor, execs } = setup();
    await executor.scheduleRestart(60, 'Professor Clippy is restarting your PC.');
    await executor.abortRestart();
    expect(execs.map((e) => [e.file, ...e.args])).toEqual([
      ['C:\\WINDOWS\\System32\\shutdown.exe', '/r', '/t', '60', '/c', 'Professor Clippy is restarting your PC.'],
      ['C:\\WINDOWS\\System32\\shutdown.exe', '/a'],
    ]);
  });
});

describe('helpers', () => {
  it('parseJsonArray takes an array, a lone object or nothing', () => {
    expect(parseJsonArray('', OpenApp)).toEqual([]);
    expect(parseJsonArray('[]', OpenApp)).toEqual([]);
    expect(parseJsonArray('{"name":"a","pid":1,"title":""}', OpenApp)).toEqual([{ name: 'a', pid: 1, title: '' }]);
    expect(() => parseJsonArray('[{"name":1}]', OpenApp)).toThrow();
  });

  it('appEnv drops ELECTRON_ and CLIPPY_ variables', () => {
    expect(appEnv({ PATH: 'p', ELECTRON_RUN_AS_NODE: '1', electron_x: 'y', CLIPPY_SENDER: 's', HOME: 'h' })).toEqual({ PATH: 'p', HOME: 'h' });
  });

  it('the default executor refuses everything', async () => {
    await expect(unavailableExecutor.findProcesses('a.exe')).rejects.toThrow(/not available/);
    await expect(unavailableExecutor.scheduleRestart(60, 'x')).rejects.toThrow(/not available/);
    expect(() => unavailableExecutor.kill(1)).toThrow(/not available/);
  });
});
