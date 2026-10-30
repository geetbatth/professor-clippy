/** First-run wizard: its steps, and the checks on what the user types. */
import type { SettingsPatch } from '@clippy/shared/settings';

export type WizardStep = 'whatsapp' | 'prefs' | 'claude';
export const WIZARD_STEPS: readonly WizardStep[] = ['whatsapp', 'prefs', 'claude'];

/** The step after `step`, or undefined after the last one. */
export function nextStep(step: WizardStep): WizardStep | undefined {
  return WIZARD_STEPS[WIZARD_STEPS.indexOf(step) + 1];
}

/**
 * The settings patch for a relay URL and secret, or what's wrong with them. The URL is the
 * Worker's address from `wrangler deploy` (https; plain http only for a local `wrangler dev`).
 */
export function relayPatch(url: string, secret: string): { patch: SettingsPatch } | { error: string } {
  const workerUrl = url.trim().replace(/\/+$/, '');
  const workerSecret = secret.trim();
  if (!workerUrl) return { error: 'Paste your Worker URL (it ends in .workers.dev).' };
  let parsed: URL;
  try {
    parsed = new URL(workerUrl);
  } catch {
    return { error: "That doesn't look like a URL. It should start with https://" };
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) {
    return { error: 'The Worker URL must start with https://' };
  }
  if (!workerSecret) return { error: 'Paste the relay secret too (the PC_SECRET you gave the Worker).' };
  return { patch: { workerUrl, workerSecret } };
}
