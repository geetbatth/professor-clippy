/**
 * Picks the backend and window shell. Inside the app that's the preload's real bridges.
 * The mock backend is used only when asked for (`?mock=1`) or in a dev build without a
 * preload (`npm run dev:renderer`). A production renderer without `window.clippy` must
 * never show fake notes: it reports the backend as missing instead.
 */
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import { ChecklistItem } from '@clippy/shared/schemas';
import { ThemeId } from '@clippy/shared/theme';
import type { ClippyWindowShell } from '../../main/window/windowApi';
import { chooseBackend } from './backendChoice';
import { createMockBackend, type MockBackend } from './mock/mockBackend';
import { SAMPLE_ORDERS, SAMPLE_WATCHES } from './mock/sampleData';

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
  onTell: () => () => {},
  blur: () => {},
};

declare global {
  interface Window {
    /** Dev hook in mock mode: `clippyMock.pushMessage({ body: 'Hi', urgent: true })`. */
    clippyMock?: MockBackend;
  }
}

/** The runtime, or `undefined` when the backend is missing (render the "brain fell out" state). */
export function resolveRuntime(search: string = location.search): Runtime | undefined {
  const choice = chooseBackend({ search, hasPreload: Boolean(window.clippy), dev: import.meta.env.DEV });
  if (choice === 'missing') return undefined;
  let api: ClippyWindowApi;
  if (choice === 'mock') {
    const params = new URLSearchParams(search);
    // `?theme=night` previews a theme; `?telegram=1` a paired Telegram; `?done=connect,answer` Getting started partly ticked.
    const theme = ThemeId.safeParse(params.get('theme'));
    const done = (params.get('done') ?? '').split(',').filter((d): d is ChecklistItem => ChecklistItem.safeParse(d).success);
    const backend = createMockBackend({
      firstRun: params.has('firstrun'),
      ...(theme.success && { theme: theme.data }),
      ...(params.has('telegram') && { telegram: { chatId: 123456789, chatName: 'You' } }),
      orders: SAMPLE_ORDERS,
      watches: SAMPLE_WATCHES,
      onboarding: { done },
    });
    window.clippyMock = backend;
    api = backend;
  } else {
    api = window.clippy!;
  }
  return { api, shell: window.clippyWindow ?? browserShell, mock: choice === 'mock', browser: !window.clippyWindow };
}
