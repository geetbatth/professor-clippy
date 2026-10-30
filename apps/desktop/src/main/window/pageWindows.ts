/**
 * Pad pages popped out onto the desktop, each its own small sticky window.
 *
 * - Follows the store: a page that becomes `popped` (and is not archived) gets a window; one that
 *   is un-popped, archived or deleted loses it. So "📌 Pin out", the window's "×" and archiving all
 *   just change the page, and the windows catch up from `page:changed` / `page:deleted`.
 * - Each window is frameless and transparent (the renderer draws the sticky), resizable, not
 *   always-on-top and kept off the taskbar. It loads the renderer with `?page=<id>`, and
 *   `&theme=<id>` (the theme to paint now) so it never shows classic yellow before settings load. Windows gives
 *   a transparent window no border to resize it by, so the sticky's corner grip resizes it from
 *   here (`pageWindow:resize*`), following the cursor like Clippy's own drag.
 * - Where a window is (`popBounds`) is saved 500 ms after it stops moving or resizing, and it
 *   reopens there on the next start (`restoreAll`), pulled onto a visible display if need be.
 * - Closing a window any other way than quitting (Alt+F4) un-pops it, like "×". While the app
 *   quits, or Windows shuts down or signs out, windows close but stay popped, so they come back.
 */
import { BrowserWindow, ipcMain, screen, type IpcMainEvent, type WebContents } from 'electron';
import type { Page, PageBounds, PageFilter, ThemeId } from '@clippy/shared';
import type { Bus } from '../core/bus';
import { defaultPreloadPath, loadRenderer, type RendererSource } from './createClippyWindow';
import type { DisplayArea } from './geometry';
import { clampBounds, defaultPageBounds, PAGE_WINDOW_MIN } from './pageBounds';
import { PAGE_HEADER_HEIGHT, PageWindowChannels } from './windowApi';

/** How long a page window must keep still before its position is saved, ms. */
export const BOUNDS_SAVE_DELAY_MS = 500;

export interface PageWindowsOptions extends RendererSource {
  /** The popped pages, and saving a window's place (or un-popping it). */
  pages: {
    list(filter: PageFilter): Page[];
    setPopped(id: string, popped: boolean, bounds?: PageBounds): Page;
  };
  bus: Bus;
  /** True while the app quits: windows closing then stay popped. */
  quitting(): boolean;
  /** The theme to paint right now (`resolveTheme` of the settings and Windows' mode), read as each window opens. */
  theme?: () => ThemeId;
  /** Defaults to the preload next to the main bundle. */
  preloadPath?: string;
  /** Diagnostics. Defaults to console.warn. */
  log?: (message: string) => void;
}

export interface PageWindows {
  /** Open the page's window (if it is not open already, and the page is not archived). */
  open(page: Page): void;
  /** Close the page's window, leaving the page as it is. */
  close(id: string): void;
  /** On start: open a window for every popped page. */
  restoreAll(): void;
  /** Is this a page window's renderer? (`registerIpc` lets those call the backend too.) */
  owns(sender: WebContents): boolean;
  /** Stop following the store and drop the IPC listener (the windows stay). */
  dispose(): void;
}

interface OpenPage {
  win: BrowserWindow;
  contents: WebContents;
  /** Shrunk to the header ("—"). */
  collapsed: boolean;
  /** The full height, kept while collapsed so that is what is saved. */
  height: number;
  saveTimer?: ReturnType<typeof setTimeout>;
  /** Being closed by us (un-popped, archived, deleted): don't un-pop it again. */
  closing: boolean;
  /** The grip is held: where the cursor and the window were when it was grabbed. */
  resizing?: { cursor: { x: number; y: number }; bounds: { x: number; y: number; width: number; height: number } };
}

/** Every display, the primary first (what `clampBounds` expects). */
function displaysPrimaryFirst(): DisplayArea[] {
  const primary = screen.getPrimaryDisplay();
  const rest = screen.getAllDisplays().filter((d) => d.id !== primary.id);
  return [primary, ...rest].map((d) => ({ id: d.id, workArea: d.workArea }));
}

export function createPageWindows(opts: PageWindowsOptions): PageWindows {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const open = new Map<string, OpenPage>();
  /**
   * Every page window's renderer, also while it closes: its last save (`beforeunload`) arrives
   * after we have let go of the window, and must still be accepted.
   */
  const pageContents = new WeakSet<WebContents>();
  /** Windows is shutting down, restarting or signing out (it may close windows before the app quits). */
  let sessionEnding = false;

  const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

  function saveBounds(id: string, entry: OpenPage): void {
    if (entry.saveTimer !== undefined) clearTimeout(entry.saveTimer);
    entry.saveTimer = undefined;
    if (entry.win.isDestroyed()) return;
    const b = entry.win.getBounds();
    const bounds: PageBounds = { ...b, height: entry.collapsed ? entry.height : b.height, displayId: screen.getDisplayMatching(b).id };
    try {
      opts.pages.setPopped(id, true, bounds);
    } catch (err) {
      log(`[clippy] saving page window position failed: ${describe(err)}`); // archived or deleted meanwhile
    }
  }

  function scheduleSave(id: string, entry: OpenPage): void {
    if (entry.saveTimer !== undefined) clearTimeout(entry.saveTimer);
    entry.saveTimer = setTimeout(() => saveBounds(id, entry), BOUNDS_SAVE_DELAY_MS);
  }

  function setCollapsed(entry: OpenPage, collapsed: boolean): void {
    if (collapsed === entry.collapsed || entry.win.isDestroyed()) return;
    const { win } = entry;
    const b = win.getBounds();
    if (collapsed) {
      entry.height = b.height;
      entry.collapsed = true;
      win.setMinimumSize(PAGE_WINDOW_MIN.width, PAGE_HEADER_HEIGHT);
      win.setResizable(false);
      win.setBounds({ ...b, height: PAGE_HEADER_HEIGHT });
    } else {
      entry.collapsed = false;
      win.setResizable(true);
      // Opening downwards may run off the bottom of the screen: pull it back in.
      const full = clampBounds({ ...b, height: entry.height, displayId: screen.getDisplayMatching(b).id }, displaysPrimaryFirst());
      win.setBounds({ x: full.x, y: full.y, width: full.width, height: full.height });
      win.setMinimumSize(PAGE_WINDOW_MIN.width, PAGE_WINDOW_MIN.height);
    }
  }

  function openPage(page: Page): void {
    if (page.archivedAt !== null || !page.popped) return;
    const existing = open.get(page.id);
    if (existing) {
      if (!existing.win.isDestroyed()) existing.win.setTitle(page.title);
      return;
    }
    const displays = displaysPrimaryFirst();
    const at = page.popBounds ? clampBounds(page.popBounds, displays) : defaultPageBounds(open.size, displays[0]!.workArea);
    const win = new BrowserWindow({
      x: at.x,
      y: at.y,
      width: at.width,
      height: at.height,
      minWidth: PAGE_WINDOW_MIN.width,
      minHeight: PAGE_WINDOW_MIN.height,
      title: page.title,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: opts.preloadPath ?? defaultPreloadPath(),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    const contents = win.webContents;
    const entry: OpenPage = { win, contents, collapsed: false, height: at.height, closing: false };
    open.set(page.id, entry);
    pageContents.add(contents);
    win.once('ready-to-show', () => win.showInactive());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (e) => e.preventDefault());

    win.on('move', () => scheduleSave(page.id, entry));
    win.on('resize', () => scheduleSave(page.id, entry));
    win.on('session-end', () => {
      sessionEnding = true;
    });
    win.on('close', (e) => {
      if (entry.closing) return;
      if (opts.quitting() || sessionEnding) {
        // Moved just before quitting: keep where it is now.
        if (entry.saveTimer !== undefined) saveBounds(page.id, entry);
        return;
      }
      // Alt+F4 and the like: the same as "×", the page goes back in the Pad.
      e.preventDefault();
      try {
        opts.pages.setPopped(page.id, false);
      } catch (err) {
        log(`[clippy] un-popping a page failed: ${describe(err)}`);
        close(page.id);
      }
    });
    win.on('closed', () => {
      if (entry.saveTimer !== undefined) clearTimeout(entry.saveTimer);
      if (open.get(page.id) === entry) open.delete(page.id);
    });

    loadRenderer(win, { rendererUrl: opts.rendererUrl, rendererFile: opts.rendererFile, query: { ...opts.query, ...(opts.theme && { theme: opts.theme() }), page: page.id } });
  }

  function close(id: string): void {
    const entry = open.get(id);
    if (!entry) return;
    entry.closing = true;
    if (entry.saveTimer !== undefined) clearTimeout(entry.saveTimer);
    entry.saveTimer = undefined;
    open.delete(id);
    if (!entry.win.isDestroyed()) entry.win.close();
  }

  /** The open page whose renderer sent this (none for any other sender). */
  const senderOf = (e: IpcMainEvent): OpenPage | undefined => [...open.values()].find((entry) => entry.contents === e.sender);

  const handlers: Record<string, (entry: OpenPage, ...args: unknown[]) => void> = {
    [PageWindowChannels.collapse]: (entry, collapsed) => setCollapsed(entry, collapsed === true),
    [PageWindowChannels.resizeStart]: (entry) => {
      if (!entry.collapsed) entry.resizing = { cursor: screen.getCursorScreenPoint(), bounds: entry.win.getBounds() };
    },
    [PageWindowChannels.resizeMove]: (entry) => {
      if (!entry.resizing) return;
      const c = screen.getCursorScreenPoint();
      const { cursor, bounds } = entry.resizing;
      entry.win.setBounds({
        ...bounds,
        width: Math.max(PAGE_WINDOW_MIN.width, bounds.width + c.x - cursor.x),
        height: Math.max(PAGE_WINDOW_MIN.height, bounds.height + c.y - cursor.y),
      });
    },
    [PageWindowChannels.resizeEnd]: (entry) => {
      entry.resizing = undefined;
    },
  };
  const listeners = Object.entries(handlers).map(([channel, handler]) => {
    const listener = (e: IpcMainEvent, ...args: unknown[]) => {
      const entry = senderOf(e);
      if (entry && !entry.win.isDestroyed()) handler(entry, ...args);
    };
    ipcMain.on(channel, listener);
    return [channel, listener] as const;
  });

  const offChanged = opts.bus.on('page:changed', (page) => {
    if (page.popped && page.archivedAt === null) openPage(page);
    else close(page.id);
  });
  const offDeleted = opts.bus.on('page:deleted', ({ id }) => close(id));

  return {
    open: openPage,
    close,
    restoreAll() {
      for (const page of opts.pages.list({})) {
        if (page.popped) openPage(page);
      }
    },
    owns: (sender) => pageContents.has(sender),
    dispose() {
      offChanged();
      offDeleted();
      for (const [channel, listener] of listeners) ipcMain.removeListener(channel, listener);
    },
  };
}
