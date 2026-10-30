import { describe, expect, it } from 'vitest';
import { RestartAppBody, RestartPcBody, Routes, routePath } from '../src/api';

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
    ]);
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
