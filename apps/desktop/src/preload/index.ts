import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import {
  IpcEvents,
  IpcInvoke,
  type ClippyBackend,
  type ClippyEvent,
  type ClippyEventMap,
  type ClippyWindowApi,
} from '@clippy/shared/ipc';
import {
  isWindowMode,
  WindowChannels,
  type ClippyWindowShell,
  type CursorPoint,
  type WindowMode,
} from '../main/window/windowApi';

// Every ClippyBackend method is forwarded to `ipcMain.handle(IpcInvoke[method], ...)` in main.
const backend = Object.fromEntries(
  Object.entries(IpcInvoke).map(([method, channel]) => [
    method,
    (...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  ]),
) as unknown as ClippyBackend;

// The page may only listen on the documented push-event channels, never on arbitrary IPC.
const knownEvents: ReadonlySet<string> = new Set(Object.values(IpcEvents));

/** Subscribe to one main → renderer channel; the IpcRendererEvent never reaches the page. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  if (typeof cb !== 'function') throw new TypeError('callback must be a function');
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: ClippyWindowApi = {
  ...backend,
  on<E extends ClippyEvent>(event: E, cb: (payload: ClippyEventMap[E]) => void) {
    if (!knownEvents.has(event)) throw new Error(`Unknown Clippy event: ${String(event)}`);
    return subscribe(event, cb);
  },
};

const shell: ClippyWindowShell = {
  setMode(mode: WindowMode) {
    if (isWindowMode(mode)) ipcRenderer.send(WindowChannels.mode, mode);
  },
  setIgnoreMouse(ignore: boolean) {
    ipcRenderer.send(WindowChannels.ignoreMouse, ignore === true);
  },
  dragStart: () => ipcRenderer.send(WindowChannels.dragStart),
  dragMove: () => ipcRenderer.send(WindowChannels.dragMove),
  dragEnd: () => ipcRenderer.send(WindowChannels.dragEnd),
  onCursor: (cb: (point: CursorPoint) => void) => subscribe(WindowChannels.cursor, cb),
  onModeChanged: (cb: (mode: WindowMode) => void) => subscribe(WindowChannels.modeChanged, cb),
  onTell: (cb: () => void) => subscribe<void>(WindowChannels.tell, () => cb()),
  blur: () => ipcRenderer.send(WindowChannels.blur),
};

contextBridge.exposeInMainWorld('clippy', api);
contextBridge.exposeInMainWorld('clippyWindow', shell);
