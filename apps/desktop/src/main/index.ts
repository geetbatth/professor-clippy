/**
 * Professor Clippy's Electron main process: one instance, the core service (local API,
 * SQLite, scheduler), settings, the brain, the WhatsApp relay, Telegram, the Clippy window and a
 * tray icon.
 */
import { homedir } from 'node:os';
import { app, BrowserWindow, globalShortcut, nativeTheme, powerMonitor } from 'electron';
import { appDataDir, settingsPath, type ClippyEvent, type ClippyEventMap, type HotkeyStatus, type Settings } from '@clippy/shared';
import { createBackend } from './backend';
import { findNode, resolveMcpServerPath } from './brain/mcpConfig';
import { resolveClaude } from './brain/runner';
import { createClaudeWiring, resolveWiringPaths } from './claudeWiring';
import { Bus } from './core/bus';
import { startServices } from './startup';
import { createTray, type ClippyTray } from './tray';
import { createClippyWindow, type ClippyWindow } from './window/createClippyWindow';
import { registerTellHotkey, type TellHotkey } from './window/hotkey';
import { registerIpc, type ClippyIpc } from './window/registerIpc';
import { forwardSystemTheme } from './window/systemTheme';
import { WindowChannels } from './window/windowApi';
import { createWindowsExecutor } from './power/executor';
import { electronSecretBox } from './secrets';
import { runInstallInUtilityProcess } from './wiringProcess';

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

  const mcpServerPath = resolveMcpServerPath({
    override: process.env.CLIPPY_MCP_PATH,
    resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
    mainDir: import.meta.dirname,
  });
  if (!mcpServerPath) console.warn('[clippy] MCP server not built (apps/mcp/dist/index.js); the brain runs without clippy tools');
  // Settings, core, brain, relay and Telegram; both channels are subscribed before any API
  // request is handled.
  const { core, settings, brain, phoneGate, watcher, brief, relay, telegram } = await startServices({
    dataDir,
    settingsFile: settingsPath(),
    version: app.getVersion(),
    bus,
    mcp: mcpServerPath ? { serverPath: mcpServerPath, dataDir, nodePath: findNode(), execPath: process.execPath } : undefined,
    brain: { emit, cwd: homedir() },
    secrets: electronSecretBox,
    // Away-only notes (the hook's "agent finished") stay quiet while the user is at the PC.
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    // Restarting an app or the PC, once the user has confirmed it (and only with the setting on).
    powerExecutor: createWindowsExecutor(),
    // A fake Bot API for trying Telegram out without the real one: dev (unpackaged) builds only.
    // The installed app always talks to https://api.telegram.org, whatever the environment says.
    ...(!app.isPackaged && process.env.CLIPPY_TELEGRAM_API && { telegram: { baseUrl: process.env.CLIPPY_TELEGRAM_API } }),
  });

  const claudeWiring = createClaudeWiring({
    paths: resolveWiringPaths({
      resourcesPath: app.isPackaged ? process.resourcesPath : undefined,
      mainDir: import.meta.dirname,
      mcpOverride: process.env.CLIPPY_MCP_PATH,
    }),
    // A sandbox for trying the wizard: wire `<dir>/.claude` instead of the real ~/.claude.
    home: process.env.CLIPPY_CLAUDE_HOME || undefined,
    findNode: () => findNode(),
    findClaude: () => resolveClaude(),
    runInstall: (job) => runInstallInUtilityProcess(job),
  });
  // The Tell Clippy hotkey; its status is what Settings shows.
  let tellHotkey: TellHotkey | undefined;
  let tellStatus: HotkeyStatus = { accelerator: settings.get().tellHotkey, ok: true };
  const backend = createBackend({ store: core.store, asks: core.asks, brain, settings, claudeWiring, telegram, hotkey: () => tellStatus, systemDark: () => nativeTheme.shouldUseDarkColors });
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

  /** (Re)register the hotkey. The one place Clippy takes keyboard focus, so the user can type. */
  const applyTellHotkey = (accelerator: string) => {
    tellHotkey?.dispose();
    tellHotkey = registerTellHotkey(
      accelerator,
      () => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
        clippy?.setMode('expanded');
        win.webContents.send(WindowChannels.tell);
      },
      globalShortcut,
    );
    tellStatus = { accelerator, ok: tellHotkey.ok, ...(tellHotkey.error && { error: tellHotkey.error }) };
    if (tellHotkey.error) console.warn(`[clippy] ${tellHotkey.error}`);
  };
  applyTellHotkey(settings.get().tellHotkey);

  // Windows switching light/dark reaches every window (the note now, popped-out pages later) at once.
  const stopSystemTheme = forwardSystemTheme(nativeTheme, () => BrowserWindow.getAllWindows());

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
    if (next.tellHotkey !== prev.tellHotkey) applyTellHotkey(next.tellHotkey);
    if (next.soundEnabled !== prev.soundEnabled) {
      if (!win.isDestroyed()) win.webContents.setAudioMuted(!next.soundEnabled);
      tray.refresh();
    }
  });
  applyLoginItem(settings.get());

  powerMonitor.on('resume', () => {
    core.scheduler.onResume();
    brief.onResume();
    // The socket may have died silently while asleep: reconnect now rather than on the next ping.
    relay.reconnect();
    telegram.poke();
  });

  // Orderly shutdown: stop the relay, Telegram and the brain, then the core (API, scheduler, database).
  let stopped = false;
  app.on('will-quit', (e) => {
    if (stopped) return;
    e.preventDefault();
    quitting = true;
    tellHotkey?.dispose();
    stopSystemTheme();
    phoneGate.stop();
    watcher.stop();
    brief.stop();
    relay.stop();
    // Aborts the long-poll in flight; never wait long for an update being handled.
    const telegramStopped = Promise.race([telegram.stop(), new Promise((r) => setTimeout(r, 2000))]);
    brain.dispose();
    tray.destroy();
    void telegramStopped
      .then(() => core.stop())
      .catch((err) => console.error('[clippy] core stop failed:', err))
      .finally(() => {
        stopped = true;
        app.quit();
      });
  });
  console.info(`[clippy] ready: API on 127.0.0.1:${core.port}, data in ${dataDir}, relay ${relay.active ? 'on' : 'off'}, telegram ${telegram.active ? 'on' : 'off'}`);
}

// The installer's appId: names the login item and groups toasts/taskbar under Professor Clippy
// (otherwise Windows sees "electron.app.Professor Clippy").
if (process.platform === 'win32') app.setAppUserModelId('com.professorclippy.app');

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
