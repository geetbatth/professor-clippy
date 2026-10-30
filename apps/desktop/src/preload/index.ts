import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcInvoke,
  type ClippyBackend,
  type ClippyEvent,
  type ClippyEventMap,
  type ClippyWindowApi,
} from '@clippy/shared/ipc';

// Every ClippyBackend method is forwarded to `ipcMain.handle(IpcInvoke[method], ...)` in main.
const backend = Object.fromEntries(
  Object.entries(IpcInvoke).map(([method, channel]) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  ]),
) as unknown as ClippyBackend;

const api: ClippyWindowApi = {
  ...backend,
  on<E extends ClippyEvent>(event: E, cb: (payload: ClippyEventMap[E]) => void) {
    const listener = (_e: IpcRendererEvent, payload: ClippyEventMap[E]) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => {
      ipcRenderer.removeListener(event, listener);
    };
  },
};

contextBridge.exposeInMainWorld('clippy', api);
