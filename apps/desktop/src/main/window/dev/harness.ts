/**
 * Dev harness (not shipped): runs the real Clippy window, preload and IPC wiring against the
 * renderer's mock backend, so the window can be tried and screenshotted before the app's
 * main process exists. Built and launched by `scripts/run-harness.mjs`.
 *
 *   --capture=<dir>   take the README screenshots into <dir>, print a log, and quit.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, type BrowserWindow } from 'electron';
import { IpcEvents } from '@clippy/shared/ipc';
import type { WindowPos } from '@clippy/shared/settings';
import { createMockBackend } from '../../../renderer/src/mock/mockBackend';
import { createClippyWindow } from '../createClippyWindow';
import { registerIpc } from '../registerIpc';

const captureDir = process.argv.find((a) => a.startsWith('--capture='))?.slice('--capture='.length);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function shot(win: BrowserWindow, dir: string, name: string): Promise<void> {
  const image = await win.webContents.capturePage();
  writeFileSync(join(dir, `${name}.png`), image.toPNG());
  console.log(`[harness] ${name}.png ${JSON.stringify(win.getBounds())}`);
}

async function capture(win: BrowserWindow, backend: ReturnType<typeof createMockBackend>, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const js = (code: string) => win.webContents.executeJavaScript(code);
  await sleep(2500);
  await shot(win, dir, 'mini');

  // An agent posts a note: Clippy jumps, the note pops open with a quip.
  backend.pushMessage({
    kind: 'note',
    title: 'Tests passed',
    body: 'checkout-service: 482 tests passed, 0 failed. Coverage up 3% to 87%.',
    sender: 'claude-code',
    project: 'checkout-service',
  });
  await sleep(1400);
  await shot(win, dir, 'expanded-new-message');
  await sleep(3000);
  await shot(win, dir, 'expanded-notes');

  await js(`[...document.querySelectorAll('.note-tab')].find((b) => b.textContent.startsWith('Clippy')).click()`);
  await sleep(400);
  await js(`(() => {
    const box = document.querySelector('.chat-input textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, 'Any wisdom for me today?');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.chat-input button[type=submit]').click();
  })()`);
  await sleep(1500);
  await shot(win, dir, 'expanded-chat');
  await js(`[...document.querySelectorAll('.note-tab')].find((b) => b.textContent.includes('Settings')).click()`);
  await sleep(400);
  await shot(win, dir, 'expanded-settings');

  // Inbox zero: dismiss everything; Clippy throws his hat.
  await js(`[...document.querySelectorAll('.note-tab')].find((b) => b.textContent.startsWith('Notes')).click()`);
  const unread = await backend.listMessages({ state: 'unread' });
  for (const m of unread) await backend.markDone(m.id);
  await sleep(900);
  await shot(win, dir, 'expanded-inbox-zero');

  // And back to mini.
  await js(`document.querySelector('.note-collapse').click()`);
  await sleep(600);
  await shot(win, dir, 'mini-after');
}

app.on('window-all-closed', () => app.quit());

void app.whenReady().then(async () => {
  let saved: WindowPos | undefined;
  const clippy = createClippyWindow({
    loadPos: () => saved,
    savePos: (pos) => {
      saved = pos;
      console.log(`[harness] savePos ${JSON.stringify(pos)}`);
    },
    hideOnFullscreen: () => true,
  });
  const backend = createMockBackend();
  const ipc = registerIpc(backend, clippy.win);
  for (const event of Object.values(IpcEvents)) backend.on(event, (payload) => ipc.emit(event, payload as never));
  console.log(`[harness] window ${JSON.stringify(clippy.win.getBounds())}`);

  if (captureDir) {
    try {
      await capture(clippy.win, backend, captureDir);
    } catch (err) {
      console.error(err);
      process.exitCode = 1;
    }
    app.quit();
  }
});
