import { describe, expect, it } from 'vitest';
import { Routes, routePath } from '../src/api';

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
    ]);
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
