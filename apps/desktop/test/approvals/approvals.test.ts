/**
 * Phone approvals end to end through the real core (store, asks, local API): who may answer one,
 * that standing orders and watches never touch one, that it goes to the phone at once, and how
 * Clippy closes the ones nobody answers.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClippyApiError, ClippyClient, type ApprovalRequestBody, type Message } from '@clippy/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  APPROVAL_EVENT,
  APPROVAL_TTL_MS,
  APPROVALS_KV_KEY,
  Approvals,
  ONLY_USER_APPROVES_MESSAGE,
} from '../../src/main/approvals/approvals';
import { startCore, type Core, type StartCoreOptions } from '../../src/main/core/core';
import { ForbiddenError } from '../../src/main/core/errors';
import { PhoneGate } from '../../src/main/phoneGate';
import { Watcher } from '../../src/main/watches';
import { alertLevel } from '../../src/renderer/src/note/alertLevel';
import { FakeClock } from '../core/fakeClock';

const T0 = Date.UTC(2026, 9, 30, 16);

let dir: string;
let clock: FakeClock;
let core: Core;
let enabled: boolean;
let active: boolean;
let client: ClippyClient;

const start = async (extra: Partial<StartCoreOptions> = {}) => {
  core = await startCore({ dataDir: dir, clock, approvalsEnabled: () => enabled, isUserActive: () => active, ...extra });
  client = new ClippyClient({ baseUrl: `http://127.0.0.1:${core.port}`, token: core.token });
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'clippy-approvals-'));
  clock = new FakeClock(T0);
  enabled = true;
  active = false;
  await start();
});
afterEach(async () => {
  await core.stop();
  rmSync(dir, { recursive: true, force: true });
});

const bash: ApprovalRequestBody = {
  sessionId: 'sess-1',
  cwd: join('C:', 'code', 'payments'),
  tool: 'Bash',
  input: { command: 'npm publish', description: 'Publish the package' },
  sender: 'claude-code',
};
/** Ask for an approval through the API; returns its ask id. */
const request = async (body: ApprovalRequestBody = bash): Promise<string> => {
  const result = await client.requestApproval(body);
  if (result.status !== 'waiting') throw new Error(`expected waiting, got ${result.status}`);
  return result.id;
};
const apiError = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as ClippyApiError);

describe('the setting and the user', () => {
  it('is off by default in startCore: nothing is posted', async () => {
    await core.stop();
    core = await startCore({ dataDir: dir, clock });
    client = new ClippyClient({ baseUrl: `http://127.0.0.1:${core.port}`, token: core.token });
    await expect(client.requestApproval(bash)).resolves.toEqual({ status: 'off' });
    expect(core.asks.listPending()).toEqual([]);
  });

  it('follows the live setting', async () => {
    enabled = false;
    await expect(client.requestApproval(bash)).resolves.toEqual({ status: 'off' });
    enabled = true;
    await expect(client.requestApproval(bash)).resolves.toMatchObject({ status: 'waiting' });
  });

  it('at the PC it posts nothing: the agent gets its normal terminal prompt', async () => {
    active = true;
    await expect(client.requestApproval(bash)).resolves.toEqual({ status: 'at-desk' });
    expect(core.asks.listPending()).toEqual([]);
    expect(core.store.getKv(APPROVALS_KV_KEY)).toBeUndefined();
  });
});

describe('a request while the user is away', () => {
  it('posts an urgent Allow/Deny question from the agent, and returns at once', async () => {
    const id = await request();
    expect(core.store.getMessage(id)).toMatchObject({
      kind: 'ask',
      body: '🔐 payments wants permission\nRun: npm publish\n(Publish the package)',
      options: ['Allow', 'Deny'],
      sender: 'claude-code',
      project: 'payments',
      urgent: true,
      state: 'unread',
      event: APPROVAL_EVENT,
    });
    expect(JSON.parse(core.store.getKv(APPROVALS_KV_KEY)!)).toEqual([{ id, createdAt: T0, sessionId: 'sess-1' }]);
    expect(core.approvals.isOpen(id)).toBe(true);
    // Loud on the desk (a question), like a restart confirmation.
    expect(alertLevel(core.store.getMessage(id)!, 'important')).toBe('loud');
  });

  it('uses the project it is given, else the folder name, else "An agent"', async () => {
    const named = await request({ ...bash, project: 'billing' });
    expect(core.store.getMessage(named)!.body).toMatch(/^🔐 billing wants permission\n/);
    const bare = await request({ tool: 'WebFetch', input: { url: 'https://x.test' }, sender: 'agent' });
    expect(core.store.getMessage(bare)).toMatchObject({ body: '🔐 An agent wants permission\nOpen https://x.test', sender: 'agent' });
    expect(core.store.getMessage(bare)).not.toHaveProperty('project');
  });

  it('the agent sees the user\'s tap through the ordinary long-poll', async () => {
    const id = await request();
    const waiting = client.waitAsk(id, 30);
    await vi.waitFor(() => expect(core.asks.waiterCount).toBe(1));
    core.asks.answer(id, 'Allow', 'telegram');
    await expect(waiting).resolves.toEqual({ id, status: 'answered', answer: 'Allow', answeredVia: 'telegram' });
    expect(core.approvals.isOpen(id)).toBe(false);
    expect(core.store.getKv(APPROVALS_KV_KEY)).toBeUndefined();
    expect(clock.pending).toBe(0); // its expiry timer is gone too
  });
});

describe('only the user answers', () => {
  it('answer_pending (the API, via clippy) is refused with 403, and the question stays open', async () => {
    const id = await request();
    // Exactly what the brain's answer_pending tool sends.
    const err = await apiError(client.answerAsk(id, 'Allow', 'clippy'));
    expect(err).toMatchObject({ status: 403 });
    expect(err!.message).toContain(ONLY_USER_APPROVES_MESSAGE);
    expect(ONLY_USER_APPROVES_MESSAGE).toBe("Only you can approve an agent's permission request: tap it on the note or in Telegram.");
    expect(core.asks.result(id)).toEqual({ id, status: 'pending' });
    expect(core.approvals.isOpen(id)).toBe(true);
  });

  it('the API never answers one, whatever via it claims (other agents use it)', async () => {
    const id = await request();
    for (const via of ['desk', 'telegram', 'whatsapp', 'clippy'] as const) {
      expect((await apiError(client.answerAsk(id, 'Allow', via)))!.status, via).toBe(403);
    }
    expect(core.asks.result(id).status).toBe('pending');
  });

  it('Asks.answer itself refuses via clippy (the in-process path)', async () => {
    const id = await request();
    expect(() => core.asks.answer(id, 'Allow', 'clippy')).toThrow(new ForbiddenError(ONLY_USER_APPROVES_MESSAGE));
    expect(core.asks.result(id).status).toBe('pending');
  });

  it.each(['desk', 'telegram', 'whatsapp'] as const)('the user answers it in-process from %s', async (via) => {
    const id = await request();
    expect(core.asks.answer(id, 'Deny', via)).toEqual({ id, status: 'answered', answer: 'Deny', answeredVia: via });
    expect(core.approvals.isOpen(id)).toBe(false);
  });

  it('other questions still take answers from Clippy and the API', async () => {
    await request();
    const ask = await client.createAsk({ question: 'Ship it?', sender: 'agent' });
    await expect(client.answerAsk(ask.id, 'yes', 'clippy')).resolves.toMatchObject({ status: 'answered' });
  });
});

describe('standing orders never answer one', () => {
  it('an approval never reaches the matcher, while a normal question is answered by it', async () => {
    await core.stop();
    const matchOrder = vi.fn(async () => ({ orderId: 'order-1', answer: 'Allow' }));
    await start({ matchOrder });
    const id = await request();
    expect(matchOrder).not.toHaveBeenCalled();
    expect(core.store.getMessage(id)).toMatchObject({ state: 'unread' });
    expect(core.store.getMessage(id)).not.toHaveProperty('answer');
    expect(core.store.getMessage(id)).not.toHaveProperty('orderId');
    // The same matcher does answer an ordinary ask: it is live, approvals just never meet it.
    const ask = await client.createAsk({ question: 'Allow npm publish?', options: ['Allow', 'Deny'], sender: 'claude-code' });
    expect(matchOrder).toHaveBeenCalledTimes(1);
    expect(ask).toMatchObject({ answer: 'Allow', orderId: 'order-1', state: 'done' });
  });

  it('an agent cannot dress a question up as an approval through POST /asks', async () => {
    const res = await fetch(`http://127.0.0.1:${core.port}/asks`, {
      method: 'POST',
      headers: { authorization: `Bearer ${core.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'q', sender: 'agent', event: APPROVAL_EVENT }),
    });
    const ask = (await res.json()) as Message;
    expect(ask).not.toHaveProperty('event');
    expect(core.approvals.isOpen(ask.id)).toBe(false);
  });
});

describe('watches and the phone', () => {
  it('a watch on the agent never fires on it; the phone gets it at once even if the user just came back', async () => {
    const watcher = new Watcher({ bus: core.bus, store: core.store, clock });
    watcher.start();
    const mirrored: string[] = [];
    core.bus.on('message:mirror', (m) => mirrored.push(m.id));
    // Away when the request was made; the gate's own check already says "at the PC".
    const gate = new PhoneGate({ bus: core.bus, store: core.store, clock, isUserAway: () => false, mode: () => 'away' });
    gate.start();
    core.store.insertWatch({ project: 'payments', event: 'any', nudge: 'Check payments' });
    core.store.insertWatch({ event: 'finished', nudge: 'Deploy' });

    const id = await request();
    expect(mirrored).toEqual([id]);
    expect(core.store.listMessages({ kind: 'note' })).toEqual([]); // no nudge
    expect(core.store.listActiveWatches()).toHaveLength(2);
    gate.stop();
    watcher.stop();
  });
});

describe('Clippy closes the ones nobody answers', () => {
  it('withdraw (the hook gave up): answered Withdrawn, once', async () => {
    const id = await request();
    const answered: string[] = [];
    core.bus.on('ask:answered', ({ message }) => answered.push(message.answer!));
    await client.withdrawApproval(id);
    expect(core.asks.result(id)).toEqual({ id, status: 'answered', answer: 'Withdrawn', answeredVia: 'clippy' });
    expect(core.approvals.isOpen(id)).toBe(false);
    await client.withdrawApproval(id); // already closed: still a 204, nothing changes
    await client.withdrawApproval('01JB2Z3K4M5N6P7Q8R9S0T1V2W'); // unknown
    expect(answered).toEqual(['Withdrawn']);
  });

  it('withdrawing one the user already answered keeps their answer', async () => {
    const id = await request();
    core.asks.answer(id, 'Allow', 'telegram');
    await client.withdrawApproval(id);
    expect(core.asks.result(id)).toMatchObject({ answer: 'Allow', answeredVia: 'telegram' });
  });

  it('expires on its own after the hook\'s wait plus a minute', async () => {
    const id = await request();
    clock.advance(APPROVAL_TTL_MS - 1);
    expect(core.asks.result(id).status).toBe('pending');
    clock.advance(1);
    expect(core.asks.result(id)).toEqual({ id, status: 'answered', answer: 'Expired', answeredVia: 'clippy' });
    expect(core.store.getKv(APPROVALS_KV_KEY)).toBeUndefined();
    expect(APPROVAL_TTL_MS).toBe(1800 * 1000);
  });

  it('dismissing the desk note closes it (Dismissed), so the agent falls back to its terminal prompt', async () => {
    const id = await request();
    core.store.markDone(id);
    expect(core.asks.result(id)).toEqual({ id, status: 'answered', answer: 'Dismissed', answeredVia: 'clippy' });
    expect(core.approvals.isOpen(id)).toBe(false);
    // Snoozing is not dismissing: it stays open.
    const other = await request();
    core.store.snooze(other, T0 + 60_000);
    expect(core.approvals.isOpen(other)).toBe(true);
  });

  it('leftovers from before a Clippy restart are expired on start', async () => {
    const a = await request();
    const b = await request();
    await core.stop();
    await start();
    const updated: string[] = [];
    core.bus.on('ask:answered', ({ message }) => updated.push(message.id));
    expect(core.approvals.isOpen(a)).toBe(true);
    core.approvals.expireLeftovers();
    expect(updated.sort()).toEqual([a, b].sort());
    for (const id of [a, b]) expect(core.asks.result(id)).toMatchObject({ answer: 'Expired', answeredVia: 'clippy' });
    expect(core.store.getKv(APPROVALS_KV_KEY)).toBeUndefined();
  });

  it('a second Approvals on the same store shares the open list (kv is the truth)', async () => {
    const id = await request();
    const other = new Approvals({ store: core.store, bus: core.bus, asks: core.asks, clock, enabled: () => true });
    expect(other.isOpen(id)).toBe(true);
    other.dispose();
  });
});
