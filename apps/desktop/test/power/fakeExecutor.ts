/**
 * An in-memory {@link PowerExecutor}: a pretend process table. Nothing real is ever listed,
 * killed, launched or shut down; every call is recorded in `calls`.
 */
import type { OpenApp } from '@clippy/shared';
import type { PowerExecutor, ProcessInfo } from '../../src/main/power/executor';

export const SELF = { pid: 1000, exePath: 'C:\\Program Files\\Professor Clippy\\Professor Clippy.exe' };
export const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/** Chrome: a root (parent explorer, 500) with `children` child processes. */
export function chrome(children = 2): ProcessInfo[] {
  const root: ProcessInfo = {
    pid: 2000,
    parentPid: 500,
    name: 'chrome.exe',
    executablePath: CHROME_PATH,
    commandLine: `"${CHROME_PATH}" --profile-directory=Default`,
    description: 'Google Chrome',
    windowTitle: 'Inbox - Google Chrome',
  };
  const kids = Array.from({ length: children }, (_, i): ProcessInfo => ({
    pid: 2001 + i,
    parentPid: 2000,
    name: 'chrome.exe',
    executablePath: CHROME_PATH,
    commandLine: `"${CHROME_PATH}" --type=renderer --id=${i}`,
    description: 'Google Chrome',
  }));
  return [root, ...kids];
}

export interface FakeExecutor extends PowerExecutor {
  calls: string[];
  /** The pretend process table (edit it to set a scene). */
  processes: ProcessInfo[];
  apps: OpenApp[];
  /** Pids `kill` refuses (EPERM). */
  refuse: Set<number>;
  /** Processes that appear after a kill (an app that starts itself again, like Explorer). */
  respawn: ProcessInfo[];
  /** Make `scheduleRestart` / `abortRestart` fail with this. */
  shutdownError?: Error;
}

export function fakeExecutor(processes: ProcessInfo[] = chrome()): FakeExecutor {
  const fake: FakeExecutor = {
    calls: [],
    processes: [...processes],
    apps: [{ name: 'chrome', pid: 2000, title: 'Inbox - Google Chrome' }],
    refuse: new Set(),
    respawn: [],
    self: SELF,
    async listOpenApps() {
      fake.calls.push('list');
      return fake.apps;
    },
    async findProcesses(exe) {
      fake.calls.push(`find ${exe}`);
      return fake.processes.filter((p) => p.name.toLowerCase() === exe.toLowerCase());
    },
    kill(pid) {
      fake.calls.push(`kill ${pid}`);
      if (fake.refuse.has(pid)) throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      if (!fake.processes.some((p) => p.pid === pid)) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      fake.processes = fake.processes.filter((p) => p.pid !== pid);
      if (fake.processes.every((p) => !fake.respawn.some((r) => r.name === p.name))) fake.processes.push(...fake.respawn.splice(0));
    },
    async launch(exePath, args) {
      fake.calls.push(`launch ${exePath} | ${args}`);
    },
    async scheduleRestart(delayS, message) {
      fake.calls.push(`shutdown /r /t ${delayS} /c ${message}`);
      if (fake.shutdownError) throw fake.shutdownError;
    },
    async abortRestart() {
      fake.calls.push('shutdown /a');
      if (fake.shutdownError) throw fake.shutdownError;
    },
    async sleep(ms) {
      fake.calls.push(`sleep ${ms}`);
    },
  };
  return fake;
}

/** The calls that change something on the machine. */
export const actions = (fake: FakeExecutor) => fake.calls.filter((c) => /^(kill|launch|shutdown)/.test(c));
