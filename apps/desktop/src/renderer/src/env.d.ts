import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { ClippyWindowShell } from '../../main/window/windowApi';

declare global {
  interface Window {
    /** Backend bridge exposed by the preload (absent in a plain browser). */
    clippy?: ClippyWindowApi;
    /** Window controls exposed by the preload (absent in a plain browser). */
    clippyWindow?: ClippyWindowShell;
  }
}
