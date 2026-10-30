/**
 * The global "Tell Clippy" shortcut: one Electron accelerator that opens the box from any app.
 * Pure over an injected `shortcuts` (Electron's `globalShortcut`), so it is testable without Electron.
 */
import type { GlobalShortcut } from 'electron';

export interface TellHotkey {
  ok: boolean;
  /** Why it didn't register (taken by another app, or not a valid accelerator). */
  error?: string;
  /** Unregister (only what this call registered). Safe to call twice. */
  dispose(): void;
}

/**
 * Register `accelerator` to call `onPress`. `''` means off. Electron throws on a malformed
 * accelerator ("isn't a valid shortcut") and returns false when another app already owns it
 * ("another app may be using it"); both come back as `ok: false` with that message.
 */
export function registerTellHotkey(
  accelerator: string,
  onPress: () => void,
  shortcuts: Pick<GlobalShortcut, 'register' | 'unregister'>,
): TellHotkey {
  if (accelerator === '') return { ok: true, dispose() {} };
  let registered = false;
  try {
    registered = shortcuts.register(accelerator, onPress);
  } catch {
    return { ok: false, error: `"${accelerator}" isn't a valid shortcut`, dispose() {} };
  }
  if (!registered) {
    return { ok: false, error: `Couldn't register ${accelerator} (another app may be using it)`, dispose() {} };
  }
  return {
    ok: true,
    dispose() {
      if (!registered) return;
      registered = false;
      shortcuts.unregister(accelerator);
    },
  };
}
