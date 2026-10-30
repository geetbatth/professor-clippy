/**
 * Professor Clippy's Electron main process: one instance, the core service (local API,
 * SQLite, scheduler), settings, the brain, the WhatsApp relay, the Clippy window and a tray icon.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, powerMonitor } from 'electron';
import { appDataDir, type ClippyEvent, type ClippyEventMap, type Settings } from '@clippy/shared';
import { createBackend } from './backend';
import { Brain } from './brain/brain';
import { findNode, resolveMcpServerPath, writeBrainFiles } from './brain/mcpConfig';
import { Bus } from './core/bus';
import { startCore, type Core } from './core/core';
import { RelayManager } from './relay';
import { SettingsStore } from './settings';
import { createTray, type ClippyTray } from './tray';
import { createClippyWindow, type ClippyWindow } from './window/createClippyWindow';
import { registerIpc, type ClippyIpc } from './window/registerIpc';

let clippy: ClippyWindow | undefined;
let quitting = false;

/** Show Clippy with the note open (tray "Show", a second launch). */
function showClippy(): void {
  if (!clippy || clippy.win.isDestroyed()) return;
  clippy.win.showInactive();
  clippy.setMode('expanded');
}

/**
 * Register (or unregister) launch at login. Only for the installed app: a dev build would
 * register `electron.exe` with a dev path.
 */
function applyLoginItem(settings: Settings): void {
  if (!app.isPackaged && process.env.CLIPPY_FORCE_LOGIN_ITEM !== '1') return;
  app.setLoginItemSettings({ openAtLogin: settings.autoStart });
}

async function main(): Promise<void> {
  await app.whenReady();
  const dataDir = appDataDir();

  // Renderer push events. The window comes later; anything before it is picked up by the
  // renderer's initial listMessages.
  let ipc: ClippyIpc | undefined;
  const emit = <E extends ClippyEvent>(event: E, payload: ClippyEventMap[E]) => ipc?.emit(event, payload);
  const bus = new Bus();
  bus.on('message:new', (m) => emit('message:new', m));
  bus.on('message:updated', (m) => emit('message:updated', m));

  const core: Core = await startCore({ dataDir, version: app.getVersion(), bus });
  const settings = await SettingsStore.load(join(dataDir, 'settings.json'));

  const mcpServerPath = resolveMcpServerPath({
    override: process.env.CLIPPY_MCP_PATH,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    mainDir: import.meta.dirname,
  });
  if (!mcpServerPath) console.warn('[clippy] MCP server not built (apps/mcp/dist/index.js); the brain runs without clippy tools');
  const brainFiles = await writeBrainFiles(
    dataDir,
    mcpServerPath ? { serverPath: mcpServerPath, dataDir, nodePath: findNode(), execPath: process.execPath } : undefined,
  );
  const brain = new Brain({
    store: core.store,
    emit,
    mcpConfigPath: brainFiles.mcpConfigPath,
    settingsPath: brainFiles.settingsPath,
    cwd: homedir(),
  });

  const backend = createBackend({ store: core.store, asks: core.asks, brain, settings });
  clippy = createClippyWindow({
    loadPos: () => settings.get().windowPos,
    savePos: (windowPos) => {
      settings.update({ windowPos }).catch((err) => console.error('[clippy] saving window position failed:', err));
    },
    hideOnFullscreen: () => settings.get().hideOnFullscreen,
  });
  const win = clippy.win;
  ipc = registerIpc(backend, win);
  win.webContents.setAudioMuted(!settings.get().soundEnabled);
  // Closing the window (Alt+F4) only hides Clippy; Quit is in the tray.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win.hide();
  });

  const relay = new RelayManager({ store: core.store, bus, scheduler: core.scheduler, asks: core.asks, brain });
  relay.apply(settings.get());

  const tray: ClippyTray = createTray({
    onShow: showClippy,
    muted: () => !settings.get().soundEnabled,
    onToggleMute: () => {
      settings.update({ soundEnabled: !settings.get().soundEnabled }).catch((err) => console.error('[clippy] mute failed:', err));
    },
    onQuit: () => app.quit(),
  });

  settings.onChange((next, prev) => {
    if (next.autoStart !== prev.autoStart) applyLoginItem(next);
    if (next.soundEnabled !== prev.soundEnabled) {
      if (!win.isDestroyed()) win.webContents.setAudioMuted(!next.soundEnabled);
      tray.refresh();
    }
    relay.apply(next);
  });
  applyLoginItem(settings.get());

  powerMonitor.on('resume', () => core.scheduler.onResume());

  // Orderly shutdown: stop the relay and brain, then the core (API, scheduler, database).
  let stopped = false;
  app.on('will-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    quitting = true;
    relay.stop();
    brain.dispose();
    tray.destroy();
    void core
      .stop()
      .catch((err) => console.error('[clippy] core stop failed:', err))
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });
  console.info(`[clippy] ready: API on 127.0.0.1:${core.port}, data in ${dataDir}, relay ${relay.active ? 'on' : 'off'}`);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showClippy);
  app.on('before-quit', () => {
    quitting = true;
  });
  // The tray keeps the app alive with no window.
  app.on('window-all-closed', () => {});
  main().catch((err) => {
    console.error('[clippy] startup failed:', err);
    app.exit(1);
  });
}
