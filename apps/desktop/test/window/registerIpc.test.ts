import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcInvoke, type ClippyBackend } from '@clippy/shared/ipc';

type Handler = (e: { sender: unknown }, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      if (handlers.has(channel)) throw new Error(`duplicate handler ${channel}`);
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => handlers.delete(channel),
  },
}));

const { registerIpc } = await import('../../src/main/window/registerIpc');

function fakeWindow() {
  const closed: (() => void)[] = [];
  const contents = { send: vi.fn(), isDestroyed: vi.fn(() => false) };
  const win = {
    webContents: contents,
    once: (event: string, cb: () => void) => {
      if (event === 'closed') closed.push(cb);
    },
  };
  return { win, contents, close: () => closed.forEach((cb) => cb()) };
}

function fakeBackend(): ClippyBackend {
  return {
    listMessages: vi.fn(async () => []),
    markDone: vi.fn(async (id: string) => ({ id }) as never),
    snooze: vi.fn(async () => ({}) as never),
    answerAsk: vi.fn(async (id: string, answer: string) => ({ id, status: 'answered' as const, answer })),
    sendChat: vi.fn(async () => ({}) as never),
    newChat: vi.fn(async () => {}),
    searchHistory: vi.fn(async () => []),
    getSettings: vi.fn(async () => ({}) as never),
    setSettings: vi.fn(async () => ({}) as never),
    connectClaude: vi.fn(async () => ({ ok: true, log: [], warnings: [] })),
    telegramStatus: vi.fn(async () => ({ tokenSaved: false, state: 'off' as const })),
    setTelegramToken: vi.fn(async () => ({ tokenSaved: true, state: 'connecting' as const })),
    telegramUnpair: vi.fn(async () => ({ tokenSaved: true, state: 'connected' as const })),
    telegramSendTest: vi.fn(async () => ({ ok: true })),
    hotkeyStatus: vi.fn(async () => ({ accelerator: 'Alt+T', ok: true })),
    listOrders: vi.fn(async () => []),
    addOrder: vi.fn(async (text: string) => ({ id: 'O1', text, active: true, createdAt: 1 })),
    cancelOrder: vi.fn(async () => {}),
    listWatches: vi.fn(async () => []),
    addWatch: vi.fn(async (input: { nudge: string }) => ({ id: 'W1', event: 'finished' as const, nudge: input.nudge, active: true, createdAt: 1 })),
    cancelWatch: vi.fn(async () => {}),
    systemDark: vi.fn(async () => true),
    listPages: vi.fn(async () => []),
    getPage: vi.fn(async (id: string) => ({ id }) as never),
    createPage: vi.fn(async (input: { title: string }) => ({ title: input.title }) as never),
    writePage: vi.fn(async () => ({ ok: true as const, page: {} as never })),
    markPageSeen: vi.fn(async () => ({}) as never),
    archivePage: vi.fn(async () => ({}) as never),
    restorePage: vi.fn(async () => ({}) as never),
    deletePage: vi.fn(async () => {}),
    popPage: vi.fn(async () => ({}) as never),
  };
}

describe('registerIpc', () => {
  beforeEach(() => handlers.clear());

  it('handles every IpcInvoke channel and forwards to the backend', async () => {
    const { win, contents } = fakeWindow();
    const backend = fakeBackend();
    registerIpc(backend, win as never);
    expect([...handlers.keys()].sort()).toEqual(Object.values(IpcInvoke).sort());

    const e = { sender: contents };
    await handlers.get(IpcInvoke.listMessages)!(e, { state: 'unread' });
    expect(backend.listMessages).toHaveBeenCalledWith({ state: 'unread' });
    await expect(handlers.get(IpcInvoke.answerAsk)!(e, 'A1', 'Yes')).resolves.toMatchObject({ answer: 'Yes' });
    await handlers.get(IpcInvoke.snooze)!(e, 'A1', 1_700_000_000_000);
    expect(backend.snooze).toHaveBeenCalledWith('A1', 1_700_000_000_000);
    await handlers.get(IpcInvoke.setSettings)!(e, { soundEnabled: false, workerUrl: null });
    expect(backend.setSettings).toHaveBeenCalledWith({ soundEnabled: false, workerUrl: null });
    await handlers.get(IpcInvoke.newChat)!(e);
    expect(backend.newChat).toHaveBeenCalledOnce();
    await handlers.get(IpcInvoke.connectClaude)!(e, 'preview');
    expect(backend.connectClaude).toHaveBeenCalledWith('preview');
    await handlers.get(IpcInvoke.setTelegramToken)!(e, '123456:abc');
    expect(backend.setTelegramToken).toHaveBeenCalledWith('123456:abc');
    await handlers.get(IpcInvoke.setTelegramToken)!(e, null);
    expect(backend.setTelegramToken).toHaveBeenLastCalledWith(null);
    await handlers.get(IpcInvoke.telegramSendTest)!(e);
    expect(backend.telegramSendTest).toHaveBeenCalledOnce();
    await expect(handlers.get(IpcInvoke.hotkeyStatus)!(e)).resolves.toEqual({ accelerator: 'Alt+T', ok: true });
    await handlers.get(IpcInvoke.listOrders)!(e);
    expect(backend.listOrders).toHaveBeenCalledOnce();
    await expect(handlers.get(IpcInvoke.addOrder)!(e, 'say yes')).resolves.toMatchObject({ text: 'say yes' });
    await handlers.get(IpcInvoke.cancelOrder)!(e, 'O1');
    expect(backend.cancelOrder).toHaveBeenCalledWith('O1');
    await handlers.get(IpcInvoke.listWatches)!(e);
    expect(backend.listWatches).toHaveBeenCalledOnce();
    await expect(handlers.get(IpcInvoke.addWatch)!(e, { project: 'api', nudge: 'Deploy' })).resolves.toMatchObject({ nudge: 'Deploy' });
    expect(backend.addWatch).toHaveBeenCalledWith({ project: 'api', nudge: 'Deploy' });
    await handlers.get(IpcInvoke.cancelWatch)!(e, 'W1');
    expect(backend.cancelWatch).toHaveBeenCalledWith('W1');
    await expect(handlers.get(IpcInvoke.systemDark)!(e)).resolves.toBe(true);
    await handlers.get(IpcInvoke.listPages)!(e, { q: 'deploy', archived: true });
    expect(backend.listPages).toHaveBeenCalledWith({ q: 'deploy', archived: true });
    await handlers.get(IpcInvoke.createPage)!(e, { title: 'Scratch', color: 'mint' });
    expect(backend.createPage).toHaveBeenCalledWith({ title: 'Scratch', color: 'mint' });
    await handlers.get(IpcInvoke.writePage)!(e, 'P1', { body: 'hi', baseUpdatedAt: 5 });
    expect(backend.writePage).toHaveBeenCalledWith('P1', { body: 'hi', baseUpdatedAt: 5 });
    await handlers.get(IpcInvoke.popPage)!(e, 'P1', true);
    expect(backend.popPage).toHaveBeenCalledWith('P1', true);
    for (const m of ['getPage', 'markPageSeen', 'archivePage', 'restorePage', 'deletePage'] as const) {
      await handlers.get(IpcInvoke[m])!(e, 'P1');
      expect(backend[m]).toHaveBeenCalledWith('P1');
    }
  });

  it('rejects bad arguments before they reach the backend', () => {
    const { win, contents } = fakeWindow();
    const backend = fakeBackend();
    registerIpc(backend, win as never);
    const e = { sender: contents };
    expect(() => handlers.get(IpcInvoke.snooze)!(e, 'A1', 'tomorrow')).toThrow();
    expect(() => handlers.get(IpcInvoke.markDone)!(e)).toThrow();
    expect(() => handlers.get(IpcInvoke.listMessages)!(e, { state: 'bogus' })).toThrow();
    expect(() => handlers.get(IpcInvoke.setSettings)!(e, { askTimeoutDefaultS: -1 })).toThrow();
    expect(() => handlers.get(IpcInvoke.sendChat)!(e, '')).toThrow();
    expect(() => handlers.get(IpcInvoke.connectClaude)!(e, 'uninstall')).toThrow();
    expect(() => handlers.get(IpcInvoke.setTelegramToken)!(e, 42)).toThrow();
    expect(() => handlers.get(IpcInvoke.hotkeyStatus)!(e, 'extra')).toThrow();
    expect(() => handlers.get(IpcInvoke.systemDark)!(e, 'extra')).toThrow();
    expect(() => handlers.get(IpcInvoke.setSettings)!(e, { theme: 'neon' })).toThrow();
    expect(() => handlers.get(IpcInvoke.addWatch)!(e, { nudge: '' })).toThrow();
    expect(() => handlers.get(IpcInvoke.addWatch)!(e, { event: 'soon', nudge: 'x' })).toThrow();
    expect(() => handlers.get(IpcInvoke.addOrder)!(e, '')).toThrow();
    expect(() => handlers.get(IpcInvoke.addOrder)!(e, 'x'.repeat(501))).toThrow();
    expect(() => handlers.get(IpcInvoke.cancelOrder)!(e)).toThrow();
    expect(() => handlers.get(IpcInvoke.createPage)!(e, { title: '' })).toThrow();
    expect(() => handlers.get(IpcInvoke.createPage)!(e, { title: 'x', body: 'x'.repeat(100_001) })).toThrow();
    expect(() => handlers.get(IpcInvoke.writePage)!(e, 'P1', { color: 'neon' })).toThrow();
    expect(() => handlers.get(IpcInvoke.writePage)!(e, 'P1', { popped: true })).toThrow();
    expect(() => handlers.get(IpcInvoke.popPage)!(e, 'P1', 'yes')).toThrow();
    expect(() => handlers.get(IpcInvoke.listPages)!(e, { archived: 'true' })).toThrow();
    expect(backend.snooze).not.toHaveBeenCalled();
    expect(backend.markDone).not.toHaveBeenCalled();
  });

  it('rejects calls from other web contents', () => {
    const { win } = fakeWindow();
    const backend = fakeBackend();
    registerIpc(backend, win as never);
    expect(() => handlers.get(IpcInvoke.getSettings)!({ sender: {} })).toThrow(/not allowed/);
    expect(backend.getSettings).not.toHaveBeenCalled();
  });

  it('accepts calls from page windows it is told about, and still refuses anyone else', async () => {
    const { win } = fakeWindow();
    const backend = fakeBackend();
    const pageWindow = { id: 'page window' };
    registerIpc(backend, win as never, { allowSender: (s) => s === (pageWindow as never) });
    await handlers.get(IpcInvoke.popPage)!({ sender: pageWindow }, 'P1', false);
    expect(backend.popPage).toHaveBeenCalledWith('P1', false);
    expect(() => handlers.get(IpcInvoke.getSettings)!({ sender: { id: 'some other page' } })).toThrow(/not allowed/);
    expect(backend.getSettings).not.toHaveBeenCalled();
  });

  it('emit pushes events to the window and stops after close', () => {
    const { win, contents, close } = fakeWindow();
    const ipc = registerIpc(fakeBackend(), win as never);
    ipc.emit('brain:state', 'thinking');
    expect(contents.send).toHaveBeenCalledWith('brain:state', 'thinking');
    close();
    expect(handlers.size).toBe(0);
    ipc.emit('brain:state', 'idle');
    expect(contents.send).toHaveBeenCalledTimes(1);
  });
});
