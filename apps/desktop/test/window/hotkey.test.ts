import { describe, expect, it, vi } from 'vitest';
import { registerTellHotkey } from '../../src/main/window/hotkey';

function fakeShortcuts(registers = true) {
  const registered = new Map<string, () => void>();
  return {
    registered,
    register: vi.fn((accel: string, cb: () => void) => {
      if (!registers) return false;
      registered.set(accel, cb);
      return true;
    }),
    unregister: vi.fn((accel: string) => void registered.delete(accel)),
  };
}

describe('registerTellHotkey', () => {
  it('registers the accelerator and calls onPress when it fires', () => {
    const shortcuts = fakeShortcuts();
    const onPress = vi.fn();
    const result = registerTellHotkey('Control+Alt+Space', onPress, shortcuts);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    shortcuts.registered.get('Control+Alt+Space')!();
    expect(onPress).toHaveBeenCalledOnce();
  });

  it('an empty accelerator means off: nothing is registered', () => {
    const shortcuts = fakeShortcuts();
    const result = registerTellHotkey('', vi.fn(), shortcuts);
    expect(result.ok).toBe(true);
    expect(shortcuts.register).not.toHaveBeenCalled();
    result.dispose();
    expect(shortcuts.unregister).not.toHaveBeenCalled();
  });

  it('reports a failure when the shortcut is taken', () => {
    const result = registerTellHotkey('Alt+T', vi.fn(), fakeShortcuts(false));
    expect(result).toMatchObject({ ok: false, error: "Couldn't register Alt+T (another app may be using it)" });
  });

  it('reports a failure, not a crash, when Electron throws on a malformed accelerator', () => {
    const shortcuts = fakeShortcuts();
    shortcuts.register.mockImplementation(() => {
      throw new TypeError('Invalid accelerator');
    });
    const result = registerTellHotkey('Banana+', vi.fn(), shortcuts);
    expect(result).toMatchObject({ ok: false, error: "Couldn't register Banana+ (another app may be using it)" });
    expect(() => result.dispose()).not.toThrow();
  });

  it('dispose unregisters, once, and only what it registered', () => {
    const shortcuts = fakeShortcuts();
    const result = registerTellHotkey('Alt+T', vi.fn(), shortcuts);
    result.dispose();
    result.dispose();
    expect(shortcuts.unregister).toHaveBeenCalledOnce();
    expect(shortcuts.unregister).toHaveBeenCalledWith('Alt+T');
    const failed = fakeShortcuts(false);
    registerTellHotkey('Alt+T', vi.fn(), failed).dispose();
    expect(failed.unregister).not.toHaveBeenCalled();
  });
});
