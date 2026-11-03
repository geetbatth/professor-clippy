/**
 * Tailscale, started or restarted when the user asks Clippy's brain to (a power action like
 * restarting an app: the user confirms first, see `actions.ts`).
 *
 * - Connected: reconnect (`tailscale down`, a short pause, `tailscale up`). No admin needed.
 * - Installed but not connected (Stopped, NoState): `tailscale up`.
 * - Its Windows service stopped: start it. That needs admin rights, so without them Windows shows
 *   a UAC prompt on the desk and the note says to approve it; nothing else is attempted.
 *
 * Restarting the service itself would also need admin, so a reconnect is what "restart" does.
 */
import { NotFoundError } from '../core/errors';
import type { PowerExecutor, TailscaleStatus } from './executor';

/** Pause between `down` and `up`, and between status checks while waiting. */
const STEP_MS = 1500;
/** Status checks while waiting for the service to start, or the backend to settle. */
const WAIT_STEPS = 10;

export const NOT_INSTALLED_MESSAGE = "Tailscale isn't installed on this PC.";

/** What confirming would do, worded for the Restart/Start question. Throws NotFoundError when it isn't installed. */
export async function describeTailscale(exec: PowerExecutor): Promise<{ verb: 'Restart' | 'Start'; question: string }> {
  const s = await exec.tailscaleStatus();
  if (!s.installed) throw new NotFoundError(NOT_INSTALLED_MESSAGE);
  if (s.service !== 'running') {
    return { verb: 'Start', question: "Start Tailscale? Its Windows service isn't running; starting it may show a Windows admin prompt on your PC." };
  }
  if (s.backend === 'Running') {
    return { verb: 'Restart', question: 'Restart Tailscale? It disconnects and reconnects, so anything using your tailnet drops for a few seconds.' };
  }
  return { verb: 'Start', question: `Start Tailscale? It's not connected (${s.backend ?? 'unknown state'}).` };
}

/** Start or reconnect Tailscale; resolves with the note to leave. */
export async function restartTailscale(exec: PowerExecutor): Promise<string> {
  let s = await exec.tailscaleStatus();
  if (!s.installed) throw new NotFoundError(NOT_INSTALLED_MESSAGE);
  const wasConnected = s.service === 'running' && s.backend === 'Running';

  if (s.service !== 'running') {
    if ((await exec.startTailscaleService()) === 'needs-approval') {
      return "Tailscale's Windows service was stopped and starting it needs admin rights, so Windows is asking on your PC. Approve that prompt and Tailscale starts.";
    }
    s = await waitFor(exec, (t) => t.service === 'running');
    if (s.service !== 'running') throw new Error("Tailscale's service didn't start. Try starting Tailscale from the Start menu.");
  } else if (wasConnected) {
    await exec.tailscaleCli('down');
    await exec.sleep(STEP_MS);
  }

  await exec.tailscaleCli('up');
  s = await waitFor(exec, (t) => t.backend === 'Running' || t.backend === 'NeedsLogin');
  if (s.backend === 'Running') return wasConnected ? "Restarted Tailscale. It's connected again." : "Started Tailscale. It's connected.";
  if (s.backend === 'NeedsLogin') return 'Tailscale is running but needs you to sign in again: open Tailscale on your PC and log in.';
  return `I asked Tailscale to connect, but it's ${s.backend ?? 'in an unknown state'} so far. It may still be connecting.`;
}

async function waitFor(exec: PowerExecutor, done: (s: TailscaleStatus) => boolean): Promise<TailscaleStatus> {
  let s = await exec.tailscaleStatus();
  for (let i = 0; i < WAIT_STEPS && !done(s); i++) {
    await exec.sleep(STEP_MS);
    s = await exec.tailscaleStatus();
  }
  return s;
}
