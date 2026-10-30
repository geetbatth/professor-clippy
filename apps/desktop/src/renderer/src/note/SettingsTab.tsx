import { useEffect, useState } from 'react';
import type { Settings } from '@clippy/shared/settings';
import type { SettingsState } from '../hooks/useSettings';
import './SettingsTab.css';

type Toggle = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

const TOGGLES: readonly { key: Toggle; label: string; hint: string }[] = [
  { key: 'hookEnabled', label: 'Claude Code hook', hint: 'Leave a note when an agent finishes or needs permission.' },
  { key: 'soundEnabled', label: 'Sounds', hint: 'Dings, boings and knocks on the glass.' },
  { key: 'unsolicitedAdvice', label: 'Unsolicited advice', hint: 'Wisdom, every 30–90 minutes, whether you like it or not.' },
  { key: 'hideOnFullscreen', label: 'Hide during fullscreen apps', hint: 'Games, films and presentations stay Clippy-free.' },
  { key: 'autoStart', label: 'Start with Windows', hint: 'Clippy turns up for work when you do.' },
];

/** Every `Settings` option: toggles, the default ask wait, and the WhatsApp relay. */
export function SettingsTab({ state }: { state: SettingsState }) {
  const { settings, update, error } = state;
  const [workerUrl, setWorkerUrl] = useState('');
  const [workerSecret, setWorkerSecret] = useState('');

  useEffect(() => {
    setWorkerUrl(settings?.workerUrl ?? '');
  }, [settings?.workerUrl]);

  if (!settings) return <p className="settings-loading">Fetching my notes…</p>;

  const relayConnected = Boolean(settings.workerUrl && settings.workerSecret);

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
            type="number"
            className="field-input"
            min={1}
            max={1440}
            value={Math.round(settings.askTimeoutDefaultS / 60)}
            onChange={(e) => {
              const minutes = Math.round(Number(e.target.value));
              if (minutes >= 1) void update({ askTimeoutDefaultS: minutes * 60 });
            }}
          />
          min
        </span>
      </label>

      <fieldset className="setting-group">
        <legend>WhatsApp relay {relayConnected ? <span className="relay-on">connected</span> : <span className="relay-off">off</span>}</legend>
        <input
          className="field-input"
          type="url"
          placeholder="https://professor-clippy-relay.example.workers.dev"
          value={workerUrl}
          aria-label="Relay URL"
          onChange={(e) => setWorkerUrl(e.target.value)}
        />
        <input
          className="field-input"
          type="password"
          placeholder={settings.workerSecret ? '•••••••• (saved)' : 'Relay secret'}
          value={workerSecret}
          aria-label="Relay secret"
          onChange={(e) => setWorkerSecret(e.target.value)}
        />
        <div className="setting-actions">
          <button
            className="btn btn-done"
            disabled={!workerUrl.trim()}
            onClick={async () => {
              const ok = await update({
                workerUrl: workerUrl.trim(),
                ...(workerSecret ? { workerSecret } : {}),
              });
              if (ok) setWorkerSecret('');
            }}
          >
            Save
          </button>
          {relayConnected && (
            <button className="btn btn-ghost" onClick={() => void update({ workerUrl: null, workerSecret: null })}>
              Disconnect
            </button>
          )}
        </div>
      </fieldset>
      {error && <p className="card-error">Couldn't save that: {error}</p>}
    </div>
  );
}
