import { describe, expect, it } from 'vitest';
import {
  APPROVAL_HOOK_TIMEOUT_S,
  APPROVAL_WAIT_S,
  ApprovalRequestBody,
  ApprovalResult,
  LookPatch,
  RestartAppBody,
  RestartPcBody,
  Routes,
  routePath,
} from '../src/api';

describe('Routes', () => {
  it('matches the local API contract exactly', () => {
    const table = Object.values(Routes).map((r) => `${r.method} ${r.path}`);
    expect(table).toEqual([
      'GET /health',
      'POST /messages',
      'GET /messages',
      'POST /messages/:id/done',
      'POST /messages/:id/snooze',
      'POST /reminders',
      'GET /reminders',
      'DELETE /reminders/:id',
      'POST /asks',
      'GET /asks/pending',
      'GET /asks/:id',
      'POST /asks/:id/answer',
      'GET /orders',
      'POST /orders',
      'DELETE /orders/:id',
      'GET /watches',
      'POST /watches',
      'DELETE /watches/:id',
      'POST /power/restart-app',
      'POST /power/restart-pc',
      'GET /power/apps',
      'POST /approvals',
      'POST /approvals/:id/withdraw',
      'POST /look',
    ]);
  });
});

describe('approvals', () => {
  it('takes a tool, a sender and any JSON input; the rest is optional', () => {
    const body = { sessionId: 's', cwd: 'C:/code/payments', project: 'payments', tool: 'Bash', input: { command: 'npm test' }, sender: 'claude-code' };
    expect(ApprovalRequestBody.parse(body)).toEqual(body);
    expect(ApprovalRequestBody.parse({ tool: 'Read', input: [1, 'x', null], sender: 'a' }).input).toEqual([1, 'x', null]);
    expect(ApprovalRequestBody.parse({ tool: 'ExitPlanMode', sender: 'a' })).toEqual({ tool: 'ExitPlanMode', sender: 'a' });
    for (const bad of [{ tool: '', sender: 'a' }, { tool: 'Bash' }, { tool: 'x'.repeat(201), sender: 'a' }, { tool: 'Bash', sender: 'a', project: '' }]) {
      expect(ApprovalRequestBody.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('answers off, at-desk, or waiting with the ask id', () => {
    expect(ApprovalResult.parse({ status: 'off' })).toEqual({ status: 'off' });
    expect(ApprovalResult.parse({ status: 'at-desk' })).toEqual({ status: 'at-desk' });
    expect(ApprovalResult.parse({ status: 'waiting', id: 'x' })).toEqual({ status: 'waiting', id: 'x' });
    expect(ApprovalResult.safeParse({ status: 'waiting' }).success).toBe(false);
  });

  it('the hook gives up before Claude Code cancels it', () => {
    expect(APPROVAL_WAIT_S).toBe(1740);
    expect(APPROVAL_HOOK_TIMEOUT_S).toBe(1800);
    expect(APPROVAL_WAIT_S).toBeLessThan(APPROVAL_HOOK_TIMEOUT_S);
  });
});

describe('power bodies', () => {
  it('takes an exe name with or without .exe, trimmed, and refuses anything that would need quoting', () => {
    expect(RestartAppBody.parse({ name: ' chrome ' })).toEqual({ name: 'chrome' });
    expect(RestartAppBody.parse({ name: 'Code.exe', reason: 'it froze' })).toEqual({ name: 'Code.exe', reason: 'it froze' });
    expect(RestartAppBody.parse({ name: 'Notepad++ (x86)' }).name).toBe('Notepad++ (x86)');
    for (const name of ['', 'a'.repeat(101), 'chrome"; calc', 'C:\\Windows\\explorer.exe', '$(calc)', 'a&b', 'a|b', "it's"]) {
      expect(RestartAppBody.safeParse({ name }).success, name).toBe(false);
    }
    expect(RestartAppBody.safeParse({ name: 'x', reason: 'r'.repeat(301) }).success).toBe(false);
  });

  it('restart-pc takes an optional reason', () => {
    expect(RestartPcBody.parse({})).toEqual({});
    expect(RestartPcBody.parse({ reason: 'updates' })).toEqual({ reason: 'updates' });
  });
});

describe('LookPatch', () => {
  it('takes any of the three look settings, but at least one', () => {
    expect(LookPatch.parse({ theme: 'night' })).toEqual({ theme: 'night' });
    expect(LookPatch.parse({ followSystemDark: true, darkTheme: 'chalkboard' })).toEqual({ followSystemDark: true, darkTheme: 'chalkboard' });
    expect(LookPatch.safeParse({}).success).toBe(false);
  });

  it('refuses an unknown theme, a light dark theme and settings that are not the look', () => {
    expect(LookPatch.safeParse({ theme: 'neon' }).success).toBe(false);
    expect(LookPatch.safeParse({ darkTheme: 'mint' }).success).toBe(false);
    // Unrelated settings are not smuggled through this route.
    expect(LookPatch.safeParse({ soundEnabled: false }).success).toBe(false);
    expect(LookPatch.safeParse({ theme: 'mint', soundEnabled: false }).success).toBe(false);
  });
});

describe('routePath', () => {
  it('returns static paths unchanged', () => {
    expect(routePath(Routes.health)).toBe('/health');
  });

  it('fills and encodes :id', () => {
    expect(routePath(Routes.answerAsk, '01ABC')).toBe('/asks/01ABC/answer');
    expect(routePath(Routes.cancelReminder, 'a/b c')).toBe('/reminders/a%2Fb%20c');
  });

  it('throws when an id is required but missing', () => {
    expect(() => routePath(Routes.markDone)).toThrow(/needs an id/);
  });
});
