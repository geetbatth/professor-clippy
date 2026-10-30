import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClippyServer, type ClippyServerOptions } from '../src/server';
import { startFakeApi, type FakeApi } from './fake-api';

let home: string;
let api: FakeApi | undefined;
let client: Client | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'clippy-mcp-'));
  process.env.CLIPPY_HOME = home;
});

afterEach(async () => {
  await client?.close();
  await api?.close();
  client = undefined;
  api = undefined;
  delete process.env.CLIPPY_HOME;
  await rm(home, { recursive: true, force: true });
});

/** Start the fake app API and an MCP client connected in-memory to a fresh server. */
async function setup(options: ClippyServerOptions = {}, { running = true } = {}) {
  if (running) api = await startFakeApi(home);
  // env: {} by default so the not-running path never finds (and launches) a real install
  const server = createClippyServer({ env: {}, ...options });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, api: api as FakeApi };
}

async function call(name: string, args: Record<string, unknown> = {}, opts?: Parameters<Client['callTool']>[2]) {
  return (await client!.callTool({ name, arguments: args }, undefined, opts)) as CallToolResult;
}

const texts = (r: CallToolResult) => r.content.map((c) => (c.type === 'text' ? c.text : ''));
const askPolls = (fake: FakeApi) => fake.requests.filter((r) => r.method === 'GET' && /^\/asks\/(?!pending)/.test(r.path));

describe('tools/list', () => {
  it('exposes the eight tools with usage guidance', async () => {
    const { client } = await setup();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'answer_pending',
        'ask_user',
        'cancel_reminder',
        'check_reply',
        'leave_message',
        'list_pending_asks',
        'list_reminders',
        'remind_me',
      ].sort(),
    );
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.leave_message!.description).toMatch(/asks you to leave them a message, notify them/);
    expect(byName.remind_me!.description).toMatch(/asks you to remind them/);
    expect(byName.ask_user!.description).toMatch(/asks you to check with them/);
    expect(byName.ask_user!.inputSchema.properties).toHaveProperty('timeout_s');
    expect(byName.remind_me!.inputSchema.required).toEqual(['body', 'when']);
    expect(client.getServerVersion()?.name).toBe('clippy');
  });
});

describe('leave_message', () => {
  it('posts the body verbatim with the MCP client name as sender and the cwd folder as project', async () => {
    const { api } = await setup();
    const r = await call('leave_message', { body: '  Build *done*  ', title: 'CI', urgent: true });
    expect(r.isError).toBeFalsy();
    expect(texts(r)[0]).toMatch(/Left the message/);
    expect(api.requests.find((q) => q.path === '/messages')?.body).toEqual({
      body: '  Build *done*  ',
      title: 'CI',
      urgent: true,
      sender: 'test-agent',
      project: basename(process.cwd()),
    });
  });

  it('uses CLIPPY_SENDER and an explicit project when given', async () => {
    const { api } = await setup({ env: { CLIPPY_SENDER: 'codex' }, project: 'payments' });
    await call('leave_message', { body: 'hi' });
    expect(api.messages[0]).toMatchObject({ sender: 'codex', project: 'payments', urgent: false });
  });
});

describe('reminders', () => {
  it('remind_me sends when + repeat as rrule; list and cancel work', async () => {
    const { api } = await setup();
    const r = await call('remind_me', { body: 'Stand up', when: '2026-11-02T09:00:00Z', repeat: 'FREQ=DAILY' });
    expect(r.isError).toBeFalsy();
    expect(texts(r)[0]).toMatch(/first due 2026-11-02T09:00:00.000Z, repeating FREQ=DAILY/);
    expect(api.requests.find((q) => q.path === '/reminders' && q.method === 'POST')?.body).toEqual({
      body: 'Stand up',
      when: '2026-11-02T09:00:00Z',
      rrule: 'FREQ=DAILY',
      sender: 'test-agent',
      project: basename(process.cwd()),
    });

    const listed = JSON.parse(texts(await call('list_reminders'))[0]!);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ body: 'Stand up', due: '2026-11-02T09:00:00.000Z', rrule: 'FREQ=DAILY' });

    const cancelled = await call('cancel_reminder', { id: listed[0].id });
    expect(texts(cancelled)[0]).toBe(`Cancelled reminder ${listed[0].id}.`);
    expect(texts(await call('list_reminders'))[0]).toBe('No active reminders.');
  });

  it('rejects a non-ISO when without calling the app', async () => {
    const { api } = await setup();
    const r = await call('remind_me', { body: 'x', when: 'tomorrow at 9' });
    expect(r.isError).toBe(true);
    expect(api.requests.some((q) => q.path === '/reminders')).toBe(false);
  });

  it('surfaces API errors (unknown reminder) as tool errors', async () => {
    await setup();
    const r = await call('cancel_reminder', { id: 'nope' });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/404: no such reminder/);
  });
});

describe('ask_user', () => {
  it('returns the answer as soon as the user replies', async () => {
    const { api } = await setup();
    setTimeout(() => api.answer(api.messages[0]!.id, 'Ship it', 'whatsapp'), 300);
    const r = await call('ask_user', { question: 'Deploy?', options: ['yes', 'no'], timeout_s: 30, urgent: true });
    const [json, prose] = texts(r);
    expect(JSON.parse(json!)).toEqual({ id: api.messages[0]!.id, status: 'answered', answer: 'Ship it', answeredVia: 'whatsapp' });
    expect(prose).toBe('The user answered (via whatsapp): Ship it');
    expect(api.messages[0]).toMatchObject({ kind: 'ask', body: 'Deploy?', options: ['yes', 'no'], urgent: true, sender: 'test-agent' });
    expect(askPolls(api).map((q) => q.query.wait)).toEqual(['30']);
  });

  it('long-polls in slices, sends progress between slices, and returns pending at the timeout', async () => {
    const { api } = await setup({ askSliceS: 1 });
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];
    const started = Date.now();
    const r = await call('ask_user', { question: 'Still there?', timeout_s: 3 }, { onprogress: (p) => progress.push(p) });
    const elapsed = Date.now() - started;

    const id = api.messages[0]!.id;
    const [json, prose] = texts(r);
    expect(JSON.parse(json!)).toEqual({ status: 'pending', id });
    expect(prose).toMatch(new RegExp(`call check_reply with id "${id}"`));
    // Every long-poll is one slice (wait=1). Usually exactly 3; shared waitAsk may add a
    // re-poll when a poll returns a hair early (its Math.ceil), so allow more.
    const polls = askPolls(api);
    expect(polls.length).toBeGreaterThanOrEqual(3);
    expect(new Set(polls.map((q) => q.query.wait))).toEqual(new Set(['1']));
    // Progress between slices: at least one, strictly increasing, total = timeout_s.
    expect(progress.length).toBeGreaterThanOrEqual(1);
    expect(progress.every((p) => p.total === 3)).toBe(true);
    expect(progress.map((p) => p.progress)).toEqual([...progress.map((p) => p.progress)].sort((a, b) => a - b));
    expect(new Set(progress.map((p) => p.progress)).size).toBe(progress.length);
    expect(progress[0]!.message).toMatch(/Waiting for the user's answer/);
    expect(elapsed).toBeGreaterThanOrEqual(2900);
    expect(elapsed).toBeLessThan(10_000);
  });

  it('sends no progress notifications when the client gave no progressToken', async () => {
    const { api } = await setup({ askSliceS: 1 });
    const notifications: unknown[] = [];
    client!.fallbackNotificationHandler = async (n) => void notifications.push(n);
    await call('ask_user', { question: 'Q', timeout_s: 2 });
    expect(askPolls(api).length).toBeGreaterThanOrEqual(2);
    expect(notifications).toEqual([]);
  });

  it('defaults the timeout to askTimeoutDefaultS from settings.json', async () => {
    const { api } = await setup();
    await writeFile(join(home, 'settings.json'), JSON.stringify({ askTimeoutDefaultS: 1 }));
    const r = await call('ask_user', { question: 'Q' });
    expect(JSON.parse(texts(r)[0]!).status).toBe('pending');
    expect(askPolls(api)[0]!.query.wait).toBe('1');
  });

  it('keeps askTimeoutDefaultS when another settings field is invalid', async () => {
    const { api } = await setup();
    await writeFile(join(home, 'settings.json'), JSON.stringify({ askTimeoutDefaultS: 1, workerUrl: 'not a url' }));
    await call('ask_user', { question: 'Q' });
    expect(askPolls(api)[0]!.query.wait).toBe('1');
  });

  it('defaults to 600 s (first slice 55 s) without settings', async () => {
    const { api } = await setup();
    setTimeout(() => api.answer(api.messages[0]!.id, 'ok', 'desk'), 200);
    const r = await call('ask_user', { question: 'Q' });
    expect(JSON.parse(texts(r)[0]!).status).toBe('answered');
    expect(askPolls(api).map((q) => q.query.wait)).toEqual(['55']);
  });

  it('timeout_s 0 posts the question and returns pending straight away', async () => {
    const { api } = await setup();
    const r = await call('ask_user', { question: 'Later?', timeout_s: 0 });
    expect(JSON.parse(texts(r)[0]!)).toEqual({ status: 'pending', id: api.messages[0]!.id });
    expect(askPolls(api).map((q) => q.query.wait)).toEqual(['0']);
  });
});

describe('pending asks', () => {
  it('check_reply, list_pending_asks and answer_pending (via clippy)', async () => {
    const { api } = await setup();
    await call('ask_user', { question: 'Which DB?', options: ['pg', 'sqlite'], timeout_s: 0 });
    const id = api.messages[0]!.id;

    expect(JSON.parse(texts(await call('check_reply', { id }))[0]!)).toEqual({ status: 'pending', id });

    const pending = JSON.parse(texts(await call('list_pending_asks'))[0]!);
    expect(pending).toEqual([
      expect.objectContaining({ id, question: 'Which DB?', options: ['pg', 'sqlite'], sender: 'test-agent' }),
    ]);

    const answered = await call('answer_pending', { id, answer: 'sqlite' });
    expect(answered.isError).toBeFalsy();
    expect(api.requests.find((q) => q.path === `/asks/${id}/answer`)?.body).toEqual({ answer: 'sqlite', via: 'clippy' });

    expect(JSON.parse(texts(await call('check_reply', { id }))[0]!)).toEqual({
      id,
      status: 'answered',
      answer: 'sqlite',
      answeredVia: 'clippy',
    });
    expect(texts(await call('list_pending_asks'))[0]).toBe('No unanswered questions.');
  });

  it('check_reply on an unknown id is a tool error', async () => {
    await setup();
    const r = await call('check_reply', { id: 'missing' });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(/404/);
  });
});

describe('app not running', () => {
  it('every tool returns "Professor Clippy isn\'t running"', async () => {
    await setup({}, { running: false });
    for (const [name, args] of [
      ['leave_message', { body: 'x' }],
      ['ask_user', { question: 'x', timeout_s: 0 }],
      ['list_reminders', {}],
    ] as const) {
      const r = await call(name, args);
      expect(r.isError).toBe(true);
      expect(texts(r)[0]).toMatch(/^Professor Clippy isn't running/);
    }
  });

  it('mentions the saved question id when the app goes away mid-ask', async () => {
    const { api } = await setup({ askSliceS: 1 });
    setTimeout(() => void api.close(), 300);
    const r = await call('ask_user', { question: 'x', timeout_s: 5 });
    expect(r.isError).toBe(true);
    expect(texts(r)[0]).toMatch(new RegExp(`isn't running.*id ${api.messages[0]!.id}`));
  });
});
