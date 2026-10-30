/**
 * Runs a real "Connect Claude Code" install in an Electron utility process (`wiringChild.js`,
 * next to the main bundle), so the seconds `claude mcp add` takes never freeze the app.
 */
import { join } from 'node:path';
import { utilityProcess } from 'electron';
import type { ClaudeWiringReport } from '@clippy/shared';
import type { WiringJob } from './claudeWiring';
import type { WiringChildMessage } from './wiringChild';

/** An install that hasn't finished by now is reported as failed (the CLI may be stuck). */
const INSTALL_TIMEOUT_MS = 120_000;

export function runInstallInUtilityProcess(job: WiringJob, mainDir: string = import.meta.dirname): Promise<ClaudeWiringReport> {
  return new Promise((resolveReport) => {
    const log: string[] = [];
    let settled = false;
    const settle = (report: ClaudeWiringReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveReport(report);
    };
    const child = utilityProcess.fork(join(mainDir, 'wiringChild.js'), [], { serviceName: 'Professor Clippy wiring' });
    const timer = setTimeout(() => {
      child.kill();
      settle({ ok: false, log, error: 'Connecting Claude Code took too long and was stopped. Try again.', warnings: [] });
    }, INSTALL_TIMEOUT_MS);
    child.on('message', (message: WiringChildMessage) => {
      if (message.type === 'log') log.push(message.line);
      else settle(message.report);
    });
    child.on('exit', (code) => settle({ ok: false, log, error: `The wiring process stopped unexpectedly (exit code ${code}).`, warnings: [] }));
    child.postMessage(job);
  });
}
