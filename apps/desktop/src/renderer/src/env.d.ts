import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { ClippyWindowShell, PageWindowShell } from '../../main/window/windowApi';

declare global {
  interface Window {
    /** Backend bridge exposed by the preload (absent in a plain browser). */
    clippy?: ClippyWindowApi;
    /** Window controls exposed by the preload (absent in a plain browser). */
    clippyWindow?: ClippyWindowShell;
    /** A popped-out page's window controls (absent in a plain browser). */
    clippyPageWindow?: PageWindowShell;
  }
}
