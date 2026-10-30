/**
 * Picks the backend and window shell: the real preload bridges inside the app, or the
 * mock backend (`?mock=1`, or whenever `window.clippy` is missing, e.g. a plain browser).
 */
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { ClippyWindowShell } from '../../main/window/windowApi';
import { createMockBackend, type MockBackend } from './mock/mockBackend';

export interface Runtime {
  api: ClippyWindowApi;
  shell: ClippyWindowShell;
  /** Running on the mock backend. */
  mock: boolean;
  /** No Electron window around us (plain browser preview). */
  browser: boolean;
}

/** Shell stand-in for a plain browser: nothing to resize, move or click through. */
const browserShell: ClippyWindowShell = {
  setMode: () => {},
  setIgnoreMouse: () => {},
  dragStart: () => {},
  dragMove: () => {},
  dragEnd: () => {},
  onCursor: () => () => {},
  onModeChanged: () => () => {},
};

declare global {
  interface Window {
    /** Dev hook in mock mode: `clippyMock.pushMessage({ body: 'Hi', urgent: true })`. */
    clippyMock?: MockBackend;
  }
}

export function resolveRuntime(search: string = location.search): Runtime {
  const params = new URLSearchParams(search);
  const mock = params.get('mock') === '1' || !window.clippy;
  let api: ClippyWindowApi;
  if (mock) {
    const backend = createMockBackend();
    window.clippyMock = backend;
    api = backend;
  } else {
    api = window.clippy!;
  }
  return { api, shell: window.clippyWindow ?? browserShell, mock, browser: !window.clippyWindow };
}
