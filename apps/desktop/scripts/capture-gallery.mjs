// Screenshot the built renderer's dev pages with Electron (no app main process needed).
//
//   npm run build -w apps/desktop
//   node apps/desktop/scripts/launch-electron.mjs apps/desktop/scripts/capture-gallery.mjs <outDir> [shots.json]
//
// Each shot loads out/renderer/index.html?<query> in a window of the given size (CSS px; `zoom`
// scales the page and the window), optionally runs `js`, freezes every CSS animation at `at` ms
// (`replay: true` restarts gallery cells first), and saves <outDir>/<name>.png.
//
// The README screenshots: ... capture-gallery.mjs docs/screenshots apps/desktop/scripts/docs-shots.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';

const rendererHtml = join(import.meta.dirname, '../out/renderer/index.html');
const [outDir = 'screenshots', shotsFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const shots = shotsFile
  ? JSON.parse(readFileSync(shotsFile, 'utf8'))
  : [
      { name: 'gallery-0', query: 'gallery=1', width: 790, height: 420, at: 0 },
      { name: 'gallery-mid', query: 'gallery=1', width: 790, height: 420, at: 450, replay: true },
    ];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot(shot) {
  const zoom = shot.zoom ?? 1;
  const win = new BrowserWindow({
    width: Math.round(shot.width * zoom),
    height: Math.round(shot.height * zoom),
    useContentSize: true,
    // Hidden windows don't repaint, so show it, but fully transparent and out of the way.
    show: false,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    frame: false,
    transparent: !!shot.transparent,
    backgroundColor: shot.transparent ? '#00000000' : '#2b4560',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      zoomFactor: zoom,
      // In-memory session: Chromium remembers zoom per page, and a persisted one would leak into
      // Electron's default profile (and so into the dev harness).
      partition: 'capture-gallery',
    },
  });
  await win.loadFile(rendererHtml, { query: Object.fromEntries(new URLSearchParams(shot.query ?? '')) });
  win.showInactive();
  await sleep(shot.settleMs ?? 600);
  if (shot.js) await win.webContents.executeJavaScript(shot.js);
  if (shot.afterJsMs) await sleep(shot.afterJsMs);
  // Replay one-shot animations (finished ones drop out of getAnimations), then freeze at `at`.
  await win.webContents.executeJavaScript(`(async () => {
    if (${!!shot.replay}) document.querySelectorAll('.gallery-cell').forEach((c) => c.click());
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    document.getAnimations().forEach((a) => { a.pause(); a.currentTime = ${shot.at ?? 0}; });
  })()`);
  await sleep(150);
  const image = await win.webContents.capturePage();
  writeFileSync(join(outDir, `${shot.name}.png`), image.toPNG());
  console.log(`saved ${shot.name}.png ${image.getSize().width}x${image.getSize().height}`);
  win.destroy();
}

// Shots open and close windows one at a time; don't quit in between.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  mkdirSync(outDir, { recursive: true });
  try {
    for (const shot of shots) await shoot(shot);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  app.quit();
});
