/**
 * Power actions end to end through the real core (store, asks, local API) with a fake executor:
 * nothing real is ever killed, launched or shut down.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClippyApiError, ClippyClient, type Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCore, type Core } from '../../src/main/core/core';
import { ForbiddenError } from '../../src/main/core/errors';
import {
  confirmsRestart,
  ONLY_USER_CONFIRMS_MESSAGE,
  POWER_KV_KEY,
  POWER_OFF_MESSAGE,
  POWER_REQUEST_TTL_MS,
  POWER_SENDER,
  PowerActions,
} from '../../src/main/power/actions';
import { askKeyboard } from '../../src/main/telegram/format';
import { matchWatches } from '../../src/main/watches';
import { FakeClock } from '../core/fakeClock';
import { actions, CHROME_PATH, fakeExecutor, type FakeExecutor } from './fakeExecutor';

const T0 = Date.UTC(2026, 9, 30, 16);

let dir: string;
let clock: FakeClock;
let core: Core;
let fake: FakeExecutor;
let allowed: boolean;
let client: ClippyClient;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clippy-power-'));
  clock = new FakeClock(T0);
  fake = fakeExecutor();
  allowed = true;
  core = await startCore({ dataDir: dir, clock, allowPowerActions: () => allowed, powerExecutor: fake });
  client = new ClippyClient({ baseUrl: `http://127.0.0.1:${core.port}`, token: core.token });
});
afterEach(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

const notes = (): Message[] => core.store.listMessages({ kind: 'note' }).filter((m) => m.sender === 'clippy');
const lastNote = () => notes()[0]?.body;
const apiError = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ClippyApiError);

describe('the setting', () => {
  it('is off by default in startCore: every power route is 403 with how to turn it on', async () => {
    await core.stop();
    core = await startCore({ dataDir: dir, clock, powerExecutor: fake });
    client = new ClippyClient({ baseUrl: `http://127.0.0.1:${core.port}`, token: core.token });
    for (const call of [() => client.restartApp('chrome'), () => client.restartPc(), () => client.listOpenApps()]) {
      const err = await apiError(call());
      expect(err).toBeInstanceOf(ClippyApiError);
      expect(err!.status).toBe(403);
      expect(err!.message).toContain(POWER_OFF_MESSAGE);
    }
    expect(fake.calls).toEqual([]);
    expect(core.asks.listPending()).toEqual([]);
  });

  it('follows the live setting', async () => {
    allowed = false;
    expect((await apiError(client.listOpenApps()))!.status).toBe(403);
    allowed = true;
    await expect(client.listOpenApps()).resolves.toEqual([{ name: 'chrome', pid: 2000, title: 'Inbox - Google Chrome' }]);
  });
});

describe('restart an app', () => {
  it('posts an urgent Restart/Cancel question from Professor Clippy and returns at once', async () => {
    const result = await client.restartApp('chrome', 'it froze');
    const question = 'Restart Google Chrome (chrome.exe, 3 processes)? Unsaved work in it may be lost. Reason: it froze';
    expect(result).toEqual({ id: expect.any(String), status: 'awaiting-confirmation', question });
    expect(core.store.getMessage(result.id)).toMatchObject({ kind: 'ask', body: question, options: ['Restart', 'Cancel'], sender: POWER_SENDER, urgent: true, state: 'unread' });
    expect(actions(fake)).toEqual([]); // nothing until the user says so
    expect(JSON.parse(core.store.getKv(POWER_KV_KEY)!)).toEqual([
      { id: result.id, kind: 'restart-app', exe: 'chrome.exe', label: 'Google Chrome', createdAt: T0 },
    ]);
    // The phone gets the same two buttons; a watch never fires on it.
    expect(askKeyboard(core.store.getMessage(result.id)!)?.inline_keyboard.map((row) => row[0]!.text)).toEqual(['Restart', 'Cancel']);
    expect(matchWatches([{ id: 'w', event: 'any', nudge: 'x', active: true, createdAt: 0 }], core.store.getMessage(result.id)!)).toEqual([]);
  });

  it('404s an app that is not running and 400s a bad name', async () => {
    const missing = await apiError(client.restartApp('notepad'));
    expect(missing).toMatchObject({ status: 404 });
    expect(missing!.message).toContain('No running app called notepad');
    expect((await apiError(client.restartApp('a & b')))!.status).toBe(400);
    expect((await apiError(client.restartApp('lsass')))!.status).toBe(403);
    expect(core.asks.listPending()).toEqual([]);
  });

  it('runs once the user taps Restart on the desk, and leaves a note', async () => {
    const { id } = await client.restartApp('chrome');
    core.asks.answer(id, 'Restart', 'desk');
    await core.power.settled();
    expect(actions(fake)).toEqual(['kill 2000', 'kill 2001', 'kill 2002', `launch ${CHROME_PATH} | --profile-directory=Default`]);
    expect(lastNote()).toBe('Restarted Google Chrome.');
    expect(core.store.getKv(POWER_KV_KEY)).toBeUndefined();
  });

  it.each(['yes', ' Y ', 'OK', 'restart'])('takes %j as a yes (from the phone)', async (answer) => {
    const { id } = await client.restartApp('chrome');
    core.asks.answer(id, answer, 'telegram');
    await core.power.settled();
    expect(actions(fake)).toContain(`launch ${CHROME_PATH} | --profile-directory=Default`);
  });

  it.each(['Cancel', 'no', 'not now', 'yes please'])('anything else (%j) cancels', async (answer) => {
    const { id } = await client.restartApp('chrome');
    core.asks.answer(id, answer, 'whatsapp');
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(lastNote()).toBe('Cancelled: I left Google Chrome alone.');
  });

  it('reports a failure in the note', async () => {
    const { id } = await client.restartApp('chrome');
    fake.refuse = new Set([2000, 2001, 2002]);
    core.asks.answer(id, 'Restart', 'desk');
    await core.power.settled();
    expect(lastNote()).toBe('I could not restart Google Chrome: Windows would not let me close Google Chrome.');
  });

  it('does nothing if the setting was turned off before the tap', async () => {
    const { id } = await client.restartApp('chrome');
    allowed = false;
    core.asks.answer(id, 'Restart', 'desk');
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(lastNote()).toMatch(/turned off in Settings now/);
  });
});

describe('only the user confirms', () => {
  it('answer_pending (the API, via clippy) is refused with 403 and nothing runs', async () => {
    const { id } = await client.restartApp('chrome');
    // Exactly what the brain's answer_pending tool sends.
    const err = await apiError(client.answerAsk(id, 'Restart', 'clippy'));
    expect(err).toMatchObject({ status: 403 });
    expect(err!.message).toContain(ONLY_USER_CONFIRMS_MESSAGE);
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(core.asks.result(id)).toEqual({ id, status: 'pending' });
    // ...still live for the user.
    core.asks.answer(id, 'Restart', 'desk');
    await core.power.settled();
    expect(actions(fake)).toContain(`launch ${CHROME_PATH} | --profile-directory=Default`);
  });

  it('the API never confirms one, whatever via it claims', async () => {
    const { id } = await client.restartPc();
    for (const via of ['desk', 'telegram', 'whatsapp'] as const) {
      expect((await apiError(client.answerAsk(id, 'Restart', via)))!.status).toBe(403);
    }
    expect(actions(fake)).toEqual([]);
  });

  it('Asks.answer itself refuses via clippy (the in-process path)', async () => {
    const { id } = await client.restartPc();
    expect(() => core.asks.answer(id, 'Restart', 'clippy')).toThrow(new ForbiddenError(ONLY_USER_CONFIRMS_MESSAGE));
    expect(core.asks.result(id).status).toBe('pending');
  });

  it('other questions still take answers from Clippy', async () => {
    const ask = await client.createAsk({ question: 'Ship it?', sender: 'agent' });
    await expect(client.answerAsk(ask.id, 'yes', 'clippy')).resolves.toMatchObject({ status: 'answered' });
  });

  it('even an answer that got past the guard is ignored when it came from Clippy', async () => {
    const power = new PowerActions({ store: core.store, bus: core.bus, asks: core.asks, clock, allowed: () => true, executor: fake });
    const ask = core.asks.create({ question: 'q', options: ['Restart'], sender: POWER_SENDER });
    core.store.setKv(POWER_KV_KEY, JSON.stringify([{ id: ask.id, kind: 'restart-pc', createdAt: T0 }]));
    core.bus.emit('ask:answered', { message: { ...ask, answer: 'Restart', answeredVia: 'clippy' }, result: { id: ask.id, status: 'answered' } });
    await power.settled();
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    power.dispose();
  });
});

describe('expiry', () => {
  it('a confirmation older than 10 minutes only leaves a note', async () => {
    const { id } = await client.restartApp('chrome');
    clock.jump(POWER_REQUEST_TTL_MS + 1); // asleep: the expiry timer has not fired yet
    core.asks.answer(id, 'Restart', 'telegram');
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(lastNote()).toMatch(/^The request to restart Google Chrome expired before you answered/);
  });

  it('an unanswered request expires on its own: answered Expired, nothing runs', async () => {
    const { id } = await client.restartApp('chrome');
    clock.advance(POWER_REQUEST_TTL_MS);
    expect(core.asks.result(id)).toEqual({ id, status: 'answered', answer: 'Expired', answeredVia: 'clippy' });
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(core.store.getKv(POWER_KV_KEY)).toBeUndefined();
  });

  it('leftovers from before a Clippy restart are expired on start without running anything', async () => {
    const app = await client.restartApp('chrome');
    const pc = await client.restartPc();
    await core.stop();
    core = await startCore({ dataDir: dir, clock, allowPowerActions: () => true, powerExecutor: fake });
    const updated: string[] = [];
    core.bus.on('ask:answered', ({ message }) => updated.push(message.id));
    expect(core.power.isConfirmation(app.id)).toBe(true);
    core.power.expireLeftovers();
    expect(updated.sort()).toEqual([app.id, pc.id].sort());
    for (const id of [app.id, pc.id]) expect(core.asks.result(id)).toMatchObject({ answer: 'Expired' });
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(core.store.getKv(POWER_KV_KEY)).toBeUndefined();
    expect(core.power.isConfirmation(app.id)).toBe(false);
  });
});

describe('restart the PC', () => {
  it('asks first, then schedules a 60 s restart and offers Cancel restart', async () => {
    const { id, question } = await client.restartPc('updates');
    expect(question).toBe('Restart your PC? Every app will close and unsaved work may be lost. Reason: updates');
    expect(actions(fake)).toEqual([]);
    core.asks.answer(id, 'Restart', 'telegram');
    await core.power.settled();
    expect(actions(fake)).toEqual(['shutdown /r /t 60 /c Professor Clippy is restarting your PC because you asked him to.']);
    const [cancel] = core.asks.listPending();
    expect(cancel).toMatchObject({ body: 'Restarting your PC in 60 seconds.', options: ['Cancel restart'], sender: POWER_SENDER, urgent: true });
    expect(core.power.isConfirmation(cancel!.id)).toBe(false);
  });

  it('Cancel restart aborts it from any channel, Clippy included', async () => {
    const { id } = await client.restartPc();
    core.asks.answer(id, 'Restart', 'desk');
    await core.power.settled();
    const [cancel] = core.asks.listPending();
    await client.answerAsk(cancel!.id, 'Cancel restart', 'clippy'); // the brain may stop a restart
    await core.power.settled();
    expect(actions(fake).at(-1)).toBe('shutdown /a');
    expect(lastNote()).toBe('Restart cancelled. Your PC stays on.');
  });

  it('a failed schedule leaves a note and no Cancel restart question', async () => {
    const { id } = await client.restartPc();
    fake.shutdownError = new Error('Access is denied.');
    core.asks.answer(id, 'Restart', 'desk');
    await core.power.settled();
    expect(lastNote()).toBe('I could not restart your PC: Access is denied.');
    expect(core.asks.listPending()).toEqual([]);
  });

  it('Cancel leaves the PC alone', async () => {
    const { id } = await client.restartPc();
    core.asks.answer(id, 'Cancel', 'desk');
    await core.power.settled();
    expect(actions(fake)).toEqual([]);
    expect(lastNote()).toBe('Cancelled: your PC stays on.');
  });
});

describe('confirmsRestart', () => {
  it('is Restart, yes, y or ok, trimmed, any case', () => {
    for (const yes of ['Restart', 'restart', ' YES ', 'y', 'Ok']) expect(confirmsRestart(yes), yes).toBe(true);
    for (const no of ['Cancel', 'no', 'yes!', 'okay', 'Restart later', '']) expect(confirmsRestart(no), no).toBe(false);
  });
});
