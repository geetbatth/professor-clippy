/**
 * Utility-process entry (`out/main/wiringChild.js`) for a real "Connect Claude Code" install.
 * The wiring runs the `claude` CLI synchronously, so it runs here instead of blocking the main
 * process. Protocol: main posts one `WiringJob`; this posts `{ type: 'log', line }` messages and
 * then `{ type: 'done', report }`, and exits.
 */
import { resolveClaude } from './brain/runner';
import { runWiringJob, wiringRunner, type WiringJob } from './claudeWiring';

export type WiringChildMessage = { type: 'log'; line: string } | { type: 'done'; report: ReturnType<typeof runWiringJob> };

const port = process.parentPort;
port.once('message', (e: Electron.MessageEvent) => {
  const job = e.data as WiringJob;
  const post = (message: WiringChildMessage) => port.postMessage(message);
  const report = runWiringJob(job, {
    runClaude: wiringRunner(resolveClaude()),
    onLog: (line) => post({ type: 'log', line }),
  });
  post({ type: 'done', report });
  // Let the message flush before exiting.
  setTimeout(() => process.exit(0), 50);
});
