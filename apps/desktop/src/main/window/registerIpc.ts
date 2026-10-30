/**
 * Wires every `ClippyBackend` method to its `IpcInvoke` channel for one window, and gives
 * main a typed way to push `IpcEvents` to that window's renderer.
 *
 * Arguments from the renderer are validated with the shared zod schemas before they reach
 * the backend. Calls are accepted from that window and from any `allowSender` vouches for (the
 * popped-out page windows); every other web contents is rejected.
 */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { z } from 'zod';
import { IpcInvoke, type ClippyBackend, type ClippyEvent, type ClippyEventMap } from '@clippy/shared/ipc';
import { ChecklistItem, MessageFilter, NewPageInput, NewStandingOrderInput, NewWatchInput, PageChange, PageFilter, TipId, Timestamp } from '@clippy/shared/schemas';
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
  systemDark: z.tuple([]),
  listPages: z.tuple([PageFilter.strict()]),
  getPage: z.tuple([id]),
  createPage: z.tuple([NewPageInput.strict()]),
  writePage: z.tuple([id, PageChange]),
  markPageSeen: z.tuple([id]),
  archivePage: z.tuple([id]),
  restorePage: z.tuple([id]),
  deletePage: z.tuple([id]),
  popPage: z.tuple([id, z.boolean()]),
  onboarding: z.tuple([]),
  markOnboarding: z.tuple([ChecklistItem]),
  dismissChecklist: z.tuple([]),
  markTipShown: z.tuple([TipId]),
  restartWelcome: z.tuple([]),
};

export interface ClippyIpc {
  /** Push an event to the window's renderer (no-op once the window is gone). */
  emit<E extends ClippyEvent>(event: E, payload: ClippyEventMap[E]): void;
  /** Remove all handlers (also done automatically when the window closes). */
  dispose(): void;
}

export interface RegisterIpcOptions {
  /** Other web contents allowed to call the backend (a popped-out page's window). */
  allowSender?: (sender: WebContents) => boolean;
}

export function registerIpc(backend: ClippyBackend, win: BrowserWindow, opts: RegisterIpcOptions = {}): ClippyIpc {
  const contents = win.webContents;
  const allowed = (sender: WebContents) => sender === contents || opts.allowSender?.(sender) === true;
  const methods = Object.keys(IpcInvoke) as (keyof ClippyBackend)[];

  for (const method of methods) {
    ipcMain.handle(IpcInvoke[method], (e: IpcMainInvokeEvent, ...raw: unknown[]) => {
      if (!allowed(e.sender)) throw new Error(`${method}: not allowed from this sender`);
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
