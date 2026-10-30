import { describe, expect, it } from 'vitest';
import { ForbiddenError, NotFoundError, ValidationError } from '../../src/main/core/errors';
import { CRITICAL_PROCESSES, commandLineArgs, findApp, isCritical, RELAUNCH_WAIT_MS, restartApp, rootProcess, toExeName } from '../../src/main/power/apps';
import type { ProcessInfo } from '../../src/main/power/executor';
import { actions, CHROME_PATH, chrome, fakeExecutor, SELF } from './fakeExecutor';

describe('names', () => {
  it('adds .exe when missing, keeps it (any case) when given, and refuses anything that is not a program name', () => {
    expect(toExeName('chrome')).toBe('chrome.exe');
    expect(toExeName(' Code.EXE ')).toBe('Code.EXE');
    expect(toExeName('Notepad++')).toBe('Notepad++.exe');
    for (const bad of ['', 'a&b', 'x"y', 'C:\\Windows\\notepad.exe', '$(calc)', 'a'.repeat(101)]) {
      expect(() => toExeName(bad), bad).toThrow(ValidationError);
    }
  });

  it('knows the Windows processes that must never be killed', () => {
    for (const name of ['System', 'lsass.exe', 'csrss', 'SVCHOST.EXE', 'dwm', 'Memory Compression', 'winlogon.exe', 'fontdrvhost']) {
      expect(isCritical(name), name).toBe(true);
    }
    expect(isCritical('chrome.exe')).toBe(false);
    expect(isCritical('explorer.exe')).toBe(false);
    expect(CRITICAL_PROCESSES.size).toBe(13);
  });
});

describe('commandLineArgs', () => {
  it('drops argv0 the way Windows splits it and keeps the rest verbatim', () => {
    expect(commandLineArgs(`"${CHROME_PATH}" --profile-directory="Profile 1" --flag`)).toBe('--profile-directory="Profile 1" --flag');
    expect(commandLineArgs('C:\\WINDOWS\\Explorer.EXE')).toBe('');
    expect(commandLineArgs('notepad.exe  C:\\notes\\a b.txt ')).toBe('C:\\notes\\a b.txt');
    expect(commandLineArgs('"C:\\x y\\app.exe"')).toBe('');
    expect(commandLineArgs('"unterminated')).toBe('');
    expect(commandLineArgs(null)).toBe('');
  });
});

describe('rootProcess', () => {
  it('is the match whose parent is not another match', () => {
    const procs = chrome(3).reverse();
    expect(rootProcess(procs)?.pid).toBe(2000);
  });

  it('takes the first of several independent instances', () => {
    const a: ProcessInfo = { pid: 7, parentPid: 1, name: 'notepad.exe', executablePath: 'C:\\n.exe', commandLine: null };
    expect(rootProcess([a, { ...a, pid: 8 }])?.pid).toBe(7);
  });
});

describe('findApp', () => {
  it('describes the app by its file description and finds the root', async () => {
    const target = await findApp(fakeExecutor(), 'Chrome');
    expect(target).toMatchObject({ exe: 'Chrome.exe', label: 'Google Chrome', root: { pid: 2000, executablePath: CHROME_PATH } });
    expect(target.processes).toHaveLength(3);
  });

  it('falls back to the window title, then the exe name', async () => {
    const procs = chrome(0).map((p) => ({ ...p, description: undefined }));
    expect((await findApp(fakeExecutor(procs), 'chrome')).label).toBe('Inbox - Google Chrome');
    expect((await findApp(fakeExecutor(procs.map((p) => ({ ...p, windowTitle: undefined }))), 'chrome')).label).toBe('chrome.exe');
  });

  it('refuses Windows processes without even looking them up', async () => {
    const fake = fakeExecutor();
    await expect(findApp(fake, 'lsass')).rejects.toThrow(ForbiddenError);
    await expect(findApp(fake, 'svchost.exe')).rejects.toThrow(/part of Windows itself/);
    expect(fake.calls).toEqual([]);
  });

  it('says when nothing by that name is running', async () => {
    await expect(findApp(fakeExecutor(), 'notepad')).rejects.toThrow(new NotFoundError('No running app called notepad'));
  });

  it('refuses Clippy itself: its exe name, its pid, its children and its exe path', async () => {
    const base: ProcessInfo = { pid: 3000, parentPid: 1, name: 'helper.exe', executablePath: 'C:\\h\\helper.exe', commandLine: null };
    await expect(findApp(fakeExecutor([]), 'Professor Clippy')).rejects.toThrow(/is me \(Professor Clippy\)/);
    for (const p of [
      { ...base, pid: SELF.pid },
      { ...base, parentPid: SELF.pid },
      { ...base, executablePath: SELF.exePath.toUpperCase() },
    ]) {
      await expect(findApp(fakeExecutor([p]), 'helper')).rejects.toThrow(/belongs to me/);
    }
  });

  it('refuses an app Windows will not show the path of (elevated or system)', async () => {
    const procs = chrome(1).map((p) => ({ ...p, executablePath: null }));
    await expect(findApp(fakeExecutor(procs), 'chrome')).rejects.toThrow(/Google Chrome runs as administrator or as part of Windows/);
  });
});

describe('restartApp', () => {
  it('kills every process, waits, and relaunches the root with its own arguments', async () => {
    const fake = fakeExecutor();
    await expect(restartApp(fake, 'chrome.exe')).resolves.toEqual({ label: 'Google Chrome', relaunched: true });
    expect(fake.calls).toEqual([
      'find chrome.exe',
      'kill 2000',
      'kill 2001',
      'kill 2002',
      `sleep ${RELAUNCH_WAIT_MS}`,
      'find chrome.exe',
      `launch ${CHROME_PATH} | --profile-directory=Default`,
    ]);
  });

  it('does not relaunch an app that started itself again (Explorer)', async () => {
    const explorer: ProcessInfo = { pid: 600, parentPid: 4, name: 'explorer.exe', executablePath: 'C:\\WINDOWS\\explorer.exe', commandLine: 'C:\\WINDOWS\\Explorer.EXE' };
    const fake = fakeExecutor([explorer]);
    fake.respawn = [{ ...explorer, pid: 601 }];
    await expect(restartApp(fake, 'explorer')).resolves.toEqual({ label: 'explorer.exe', relaunched: false });
    expect(actions(fake)).toEqual(['kill 600']);
  });

  it('ignores processes that are already gone (ESRCH)', async () => {
    const fake = fakeExecutor();
    const real = fake.kill;
    fake.kill = (pid) => {
      if (pid === 2000) fake.processes = fake.processes.filter((p) => p.parentPid !== 2000); // children go with the parent
      real(pid);
    };
    await expect(restartApp(fake, 'chrome')).resolves.toMatchObject({ relaunched: true });
  });

  it('fails without relaunching when Windows refuses every kill, or some processes survive', async () => {
    const fake = fakeExecutor();
    fake.refuse = new Set([2000, 2001, 2002]);
    await expect(restartApp(fake, 'chrome')).rejects.toThrow('Windows would not let me close Google Chrome.');
    expect(fake.calls.some((c) => c.startsWith('launch'))).toBe(false);

    const partial = fakeExecutor();
    partial.refuse = new Set([2001]);
    await expect(restartApp(partial, 'chrome')).rejects.toThrow('1 of its processes would not close, so I did not start it again.');
    expect(partial.calls.some((c) => c.startsWith('launch'))).toBe(false);
  });

  it('says so when the app closed in the meantime', async () => {
    await expect(restartApp(fakeExecutor([]), 'chrome')).rejects.toThrow('No running app called chrome');
  });
});
