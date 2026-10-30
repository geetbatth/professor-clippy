import { useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { SettingsState } from '../hooks/useSettings';
import { ConnectClaude } from './ConnectClaude';
import { nextStep, relayPatch, WIZARD_STEPS, type WizardStep } from './firstRun';
import './FirstRunWizard.css';

const PREFS = [
  { key: 'soundEnabled', label: 'Sounds', hint: 'Dings, boings and knocks on the glass.' },
  { key: 'unsolicitedAdvice', label: 'Unsolicited advice', hint: 'Wisdom, every 30–90 minutes, whether you like it or not.' },
  { key: 'autoStart', label: 'Start with Windows', hint: 'I turn up for work when you do.' },
] as const;

/**
 * First run, inside the note: WhatsApp relay (or skip), sounds and advice, then
 * "Connect Claude Code". Finishing (or skipping) sets `firstRunDone`.
 */
export function FirstRunWizard({ api, state }: { api: ClippyWindowApi; state: SettingsState }) {
  const { settings, update, error: saveError } = state;
  const [step, setStep] = useState<WizardStep>('whatsapp');
  const [workerUrl, setWorkerUrl] = useState('');
  const [workerSecret, setWorkerSecret] = useState('');
  const [relayError, setRelayError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [claudeConnected, setClaudeConnected] = useState(false);

  if (!settings) return <p className="settings-loading">Fetching my notes…</p>;

  const advance = () => {
    const next = nextStep(step);
    if (next) setStep(next);
    else void update({ firstRunDone: true });
  };
  const saveRelay = async () => {
    const result = relayPatch(workerUrl, workerSecret);
    if ('error' in result) {
      setRelayError(result.error);
      return;
    }
    setRelayError(undefined);
    setSaving(true);
    const ok = await update(result.patch);
    setSaving(false);
    if (ok) {
      setWorkerSecret('');
      advance();
    }
  };

  return (
    <div className="wizard">
      <ol className="wizard-steps" aria-label="Setup steps">
        {WIZARD_STEPS.map((s, i) => (
          <li key={s} className={s === step ? 'on' : WIZARD_STEPS.indexOf(step) > i ? 'done' : ''}>
            {i + 1}
          </li>
        ))}
      </ol>

      {step === 'whatsapp' && (
        <section>
          <h2 className="wizard-title">Welcome! I'm Professor Clippy.</h2>
          <p className="wizard-text">
            Your AI agents leave me notes, reminders and questions, and I make sure you see them. I can copy every one to your
            WhatsApp too, through your own Cloudflare Worker.
          </p>
          <p className="wizard-text wizard-small">
            Paste the Worker URL from <code>wrangler deploy</code> and the <code>PC_SECRET</code> you gave it (see
            docs/USER-TODO.md).
          </p>
          <input
            className="field-input"
            type="url"
            placeholder="https://professor-clippy-relay.you.workers.dev"
            value={workerUrl}
            aria-label="Worker URL"
            onChange={(e) => setWorkerUrl(e.target.value)}
          />
          <input
            className="field-input"
            type="password"
            placeholder="Relay secret (PC_SECRET)"
            value={workerSecret}
            aria-label="Relay secret"
            onChange={(e) => setWorkerSecret(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void saveRelay()}
          />
          {(relayError ?? saveError) && <p className="card-error">{relayError ?? `Couldn't save that: ${saveError}`}</p>}
          <div className="setting-actions">
            <button className="btn btn-done" disabled={saving} onClick={() => void saveRelay()}>
              {saving ? 'Saving…' : 'Connect WhatsApp'}
            </button>
            <button className="btn btn-ghost" onClick={advance}>
              Skip WhatsApp for now
            </button>
          </div>
        </section>
      )}

      {step === 'prefs' && (
        <section>
          <h2 className="wizard-title">How lively should I be?</h2>
          {PREFS.map(({ key, label, hint }) => (
            <label key={key} className="setting">
              <span className="setting-text">
                <span className="setting-label">{label}</span>
                <span className="setting-hint">{hint}</span>
              </span>
              <input type="checkbox" className="switch" checked={settings[key]} onChange={(e) => void update({ [key]: e.target.checked })} />
            </label>
          ))}
          <p className="wizard-text wizard-small">You can change these, and the rest, in Settings any time.</p>
          <div className="setting-actions">
            <button className="btn btn-done" onClick={advance}>
              Next
            </button>
          </div>
        </section>
      )}

      {step === 'claude' && (
        <section>
          <h2 className="wizard-title">Connect Claude Code</h2>
          <p className="wizard-text">
            I'll register my MCP server with Claude Code (so agents can leave notes, set reminders and ask you things), add a
            hook that tells me when an agent finishes or needs permission, and add a hint to your global CLAUDE.md. You see the
            exact changes first.
          </p>
          <ConnectClaude api={api} onInstalled={() => setClaudeConnected(true)} />
          <div className="setting-actions wizard-finish">
            <button className={`btn ${claudeConnected ? 'btn-done' : 'btn-ghost'}`} onClick={advance}>
              {claudeConnected ? 'Finish' : 'Skip for now (Settings has this too)'}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
