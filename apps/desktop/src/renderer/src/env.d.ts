import type { ClippyWindowApi } from '@clippy/shared/ipc';

declare global {
  interface Window {
    /** Exposed by the preload script. */
    clippy: ClippyWindowApi;
  }
}
