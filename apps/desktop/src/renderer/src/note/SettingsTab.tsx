import { useEffect, useState } from 'react';
import type { ClippyWindowApi, TelegramStatus } from '@clippy/shared/ipc';
import type { Settings } from '@clippy/shared/settings';
import type { SettingsState } from '../hooks/useSettings';
import { ASK_WAIT_MAX_MINUTES, ASK_WAIT_MIN_MINUTES, askWaitMinutes, parseAskWait } from './askWait';
import { ConnectClaude } from './ConnectClaude';
import { relayBadge, relayPatch } from './firstRun';
import { TelegramBadge, TelegramSetup } from './TelegramSetup';
import './SettingsTab.css';

type Toggle = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

const TOGGLES: readonly { key: Toggle; label: string; hint: string }[] = [
  { key: 'hookEnabled', label: 'Claude Code hook', hint: 'Leave a note when an agent finishes or needs permission.' },
  { key: 'soundEnabled', label: 'Sounds', hint: 'Dings, boings and knocks on the glass.' },
  { key: 'unsolicitedAdvice', label: 'Unsolicited advice', hint: 'Wisdom, every 30–90 minutes, whether you like it or not.' },
  { key: 'hideOnFullscreen', label: 'Hide during fullscreen apps', hint: 'Games, films and presentations stay Clippy-free.' },
  { key: 'autoStart', label: 'Start with Windows', hint: 'Clippy turns up for work when you do.' },
];

/** Every `Settings` option: toggles, the default ask wait, WhatsApp, Telegram, and Claude Code wiring. */
export function SettingsTab({ api, state }: { api: ClippyWindowApi; state: SettingsState }) {
  const { settings, update, error } = state;
  const [workerUrl, setWorkerUrl] = useState('');
  const [workerSecret, setWorkerSecret] = useState('');
  const [relayError, setRelayError] = useState<string>();

  const [askWait, setAskWait] = useState('');
  const [askWaitError, setAskWaitError] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus>();

  useEffect(() => {
    setWorkerUrl(settings?.workerUrl ?? '');
  }, [settings?.workerUrl]);
  useEffect(() => {
    if (settings) setAskWait(askWaitMinutes(settings.askTimeoutDefaultS));
  }, [settings?.askTimeoutDefaultS]);

  if (!settings) return <p className="settings-loading">Fetching my notes…</p>;

  /** Save the ask wait on blur / Enter, only if it's valid and changed. */
  const commitAskWait = () => {
    const seconds = parseAskWait(askWait);
    if (seconds === undefined) {
      setAskWaitError(true);
      return;
    }
    setAskWaitError(false);
    setAskWait(askWaitMinutes(seconds));
    if (seconds !== settings.askTimeoutDefaultS) void update({ askTimeoutDefaultS: seconds });
  };

  const relaySaved = relayBadge(settings) === 'saved';

  /** Save the relay fields with the wizard's checks (https only, trimmed, secret required). */
  const saveRelay = async () => {
    const result = relayPatch(workerUrl, workerSecret, { secretSaved: Boolean(settings.workerSecret) });
    if ('error' in result) {
      setRelayError(result.error);
      return;
    }
    setRelayError(undefined);
    const ok = await update(result.patch);
    if (ok) {
      setWorkerSecret('');
      if (result.patch.workerUrl) setWorkerUrl(result.patch.workerUrl);
    }
  };

  return (
    <div className="settings">
      {TOGGLES.map(({ key, label, hint }) => (
        <label key={key} className="setting">
          <span className="setting-text">
            <span className="setting-label">{label}</span>
            <span className="setting-hint">{hint}</span>
          </span>
          <input
            type="checkbox"
            className="switch"
            checked={settings[key]}
            onChange={(e) => void update({ [key]: e.target.checked })}
          />
        </label>
      ))}

      <label className="setting">
        <span className="setting-text">
          <span className="setting-label">Wait for answers</span>
          <span className="setting-hint">How long an agent's question waits before it gets "no answer yet".</span>
        </span>
        <span className="setting-number">
          <input
            type="text"
            inputMode="numeric"
            className={`field-input${askWaitError ? ' field-input--bad' : ''}`}
            value={askWait}
            aria-invalid={askWaitError}
            onChange={(e) => {
              setAskWait(e.target.value);
              setAskWaitError(false);
            }}
            onBlur={commitAskWait}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAskWait();
              if (e.key === 'Escape') setAskWait(askWaitMinutes(settings.askTimeoutDefaultS));
            }}
          />
          min
        </span>
      </label>
      {askWaitError && (
        <p className="card-error">
          Whole minutes between {ASK_WAIT_MIN_MINUTES} and {ASK_WAIT_MAX_MINUTES}, please.
        </p>
      )}

      <fieldset className="setting-group">
        <legend>
          WhatsApp relay{' '}
          {relaySaved ? (
            <span className="relay-on" title="Worker URL and secret saved. Messages go out while the Worker is reachable.">
              saved
            </span>
          ) : (
            <span className="relay-off">off</span>
          )}
        </legend>
        <input
          className={`field-input${relayError ? ' field-input--bad' : ''}`}
          type="url"
          placeholder="https://professor-clippy-relay.example.workers.dev"
          value={workerUrl}
          aria-label="Relay URL"
          aria-invalid={Boolean(relayError)}
          onChange={(e) => {
            setWorkerUrl(e.target.value);
            setRelayError(undefined);
          }}
        />
        <input
          className="field-input"
          type="password"
          placeholder={settings.workerSecret ? '•••••••• (saved)' : 'Relay secret'}
          value={workerSecret}
          aria-label="Relay secret"
          onChange={(e) => {
            setWorkerSecret(e.target.value);
            setRelayError(undefined);
          }}
        />
        <div className="setting-actions">
          <button className="btn btn-done" disabled={!workerUrl.trim()} onClick={() => void saveRelay()}>
            Save
          </button>
          {(settings.workerUrl || settings.workerSecret) && (
            <button
              className="btn btn-ghost"
              title="Also deletes your reminders from the Worker, so it stops sending them."
              onClick={() => {
                setRelayError(undefined);
                void update({ workerUrl: null, workerSecret: null });
              }}
            >
              Disconnect
            </button>
          )}
        </div>
      </fieldset>
      {relayError && <p className="card-error">{relayError}</p>}
      {error && <p className="card-error">Couldn't save that: {error}</p>}

      <fieldset className="setting-group">
        <legend>
          Telegram <TelegramBadge status={telegram} />
        </legend>
        <span className="setting-hint">Notes, reminders and questions on your phone through your own bot, no Worker needed.</span>
        <TelegramSetup api={api} update={update} onStatus={setTelegram} />
      </fieldset>

      <fieldset className="setting-group">
        <legend>Claude Code</legend>
        <span className="setting-hint">Register my MCP server, hook and CLAUDE.md hint (shows the changes first).</span>
        <ConnectClaude api={api} />
      </fieldset>
    </div>
  );
}
