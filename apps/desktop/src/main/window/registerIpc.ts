/**
 * Wires every `ClippyBackend` method to its `IpcInvoke` channel for one window, and gives
 * main a typed way to push `IpcEvents` to that window's renderer.
 *
 * Arguments from the renderer are validated with the shared zod schemas before they reach
 * the backend, and calls from any other web contents are rejected.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IpcInvoke, type ClippyBackend, type ClippyEvent, type ClippyEventMap } from '@clippy/shared/ipc';
import { MessageFilter, NewStandingOrderInput, NewWatchInput, Timestamp } from '@clippy/shared/schemas';
import { SettingsPatch } from '@clippy/shared/settings';

const id = z.string().min(1);
const text = z.string().min(1);

/** Argument schema per backend method (a tuple of its parameters). */
const argSchemas: { [K in keyof ClippyBackend]: z.ZodType<Parameters<ClippyBackend[K]>> } = {
  listMessages: z.tuple([MessageFilter]),
  markDone: z.tuple([id]),
  snooze: z.tuple([id, Timestamp]),
  answerAsk: z.tuple([id, text]),
  sendChat: z.tuple([text]),
  newChat: z.tuple([]),
  searchHistory: z.tuple([z.string()]),
  getSettings: z.tuple([]),
  setSettings: z.tuple([SettingsPatch]),
  connectClaude: z.tuple([z.enum(['preview', 'install'])]),
  telegramStatus: z.tuple([]),
  setTelegramToken: z.tuple([z.string().max(200).nullable()]),
  telegramUnpair: z.tuple([]),
  telegramSendTest: z.tuple([]),
  hotkeyStatus: z.tuple([]),
  listOrders: z.tuple([]),
  addOrder: z.tuple([NewStandingOrderInput.shape.text]),
  cancelOrder: z.tuple([id]),
  listWatches: z.tuple([]),
  addWatch: z.tuple([NewWatchInput]),
  cancelWatch: z.tuple([id]),
};

export interface ClippyIpc {
  /** Push an event to the window's renderer (no-op once the window is gone). */
  emit<E extends ClippyEvent>(event: E, payload: ClippyEventMap[E]): void;
  /** Remove all handlers (also done automatically when the window closes). */
  dispose(): void;
}

export function registerIpc(backend: ClippyBackend, win: BrowserWindow): ClippyIpc {
  const contents = win.webContents;
  const methods = Object.keys(IpcInvoke) as (keyof ClippyBackend)[];

  for (const method of methods) {
    ipcMain.handle(IpcInvoke[method], (e: IpcMainInvokeEvent, ...raw: unknown[]) => {
      if (e.sender !== contents) throw new Error(`${method}: not allowed from this sender`);
      const args = argSchemas[method].parse(raw) as unknown[];
      const fn = backend[method] as (...a: unknown[]) => Promise<unknown>;
      return fn.apply(backend, args);
    });
  }

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const method of methods) ipcMain.removeHandler(IpcInvoke[method]);
  };
  win.once('closed', dispose);

  return {
    emit(event, payload) {
      if (!disposed && !contents.isDestroyed()) contents.send(event, payload);
    },
    dispose,
  };
}
