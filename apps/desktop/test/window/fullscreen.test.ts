import { describe, expect, it, vi } from 'vitest';
import { createFullscreenGate, parseNotificationState, probeScript } from '../../src/main/window/fullscreen';

describe('parseNotificationState', () => {
  it('maps SHQueryUserNotificationState values', () => {
    expect(parseNotificationState('2')).toBe(true); // busy: fullscreen app
    expect(parseNotificationState('3')).toBe(true); // D3D fullscreen
    expect(parseNotificationState('4')).toBe(true); // presentation mode
    expect(parseNotificationState('5\r')).toBe(false); // accepts notifications
    expect(parseNotificationState(' 1 ')).toBe(false); // locked / screen saver
    expect(parseNotificationState('7')).toBe(false);
  });
  it('ignores noise', () => {
    expect(parseNotificationState('')).toBeUndefined();
    expect(parseNotificationState('Add-Type : error')).toBeUndefined();
  });
});

describe('probeScript', () => {
  it('watches the parent pid and polls at the interval', () => {
    const s = probeScript(4242, 1500);
    expect(s).toContain('Get-Process -Id 4242');
    expect(s).toContain('Start-Sleep -Milliseconds 1500');
    expect(s).toContain('SHQueryUserNotificationState');
  });
});

describe('createFullscreenGate', () => {
  function setup(enabled = true) {
    const flags = { enabled };
    const hide = vi.fn();
    const show = vi.fn();
    const gate = createFullscreenGate({ enabled: () => flags.enabled, hide, show });
    return { flags, hide, show, gate };
  }

  it('hides once while fullscreen and shows again afterwards', () => {
    const { gate, hide, show } = setup();
    gate(false);
    gate(true);
    gate(true);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled();
    gate(false);
    gate(false);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the setting is off', () => {
    const { gate, hide, show } = setup(false);
    gate(true);
    gate(false);
    expect(hide).not.toHaveBeenCalled();
    expect(show).not.toHaveBeenCalled();
  });

  it('re-shows when the setting is switched off mid-fullscreen', () => {
    const { gate, flags, hide, show } = setup();
    gate(true);
    flags.enabled = false;
    gate(true);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('never shows a window it did not hide', () => {
    const { gate, show } = setup();
    gate(false);
    expect(show).not.toHaveBeenCalled();
  });
});
