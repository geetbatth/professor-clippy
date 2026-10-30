import { Fragment, useEffect, useState } from 'react';
import type { ClippyWindowApi, HotkeyStatus, TelegramStatus } from '@clippy/shared/ipc';
import type { Settings } from '@clippy/shared/settings';
import type { SettingsState } from '../hooks/useSettings';
import { ASK_WAIT_MAX_MINUTES, ASK_WAIT_MIN_MINUTES, askWaitMinutes, parseAskWait } from './askWait';
import { AWAY_MAX_MINUTES, awayMinutes, parseAwayMinutes } from './awayThreshold';
import { ConnectClaude } from './ConnectClaude';
import { relayBadge, relayPatch } from './firstRun';
import { RulesSection } from './RulesSection';
import { TelegramBadge, TelegramSetup } from './TelegramSetup';
import './SettingsTab.css';

type Toggle = { [K in keyof Settings]-?: Settings[K] extends boolean ? K : never }[keyof Settings];

const TOGGLES: readonly { key: Toggle; label: string; hint: string }[] = [
  { key: 'hookEnabled', label: 'Claude Code hook', hint: 'Leave a note when an agent finishes or needs permission.' },
  { key: 'soundEnabled', label: 'Sounds', hint: 'Dings, boings and knocks on the glass.' },
  { key: 'unsolicitedAdvice', label: 'Unsolicited advice', hint: 'Wisdom, every 30–90 minutes, whether you like it or not.' },
  { key: 'briefEnabled', label: 'Morning brief', hint: 'A note from me each morning: your reminders, what waits on you, what the agents did overnight.' },
  { key: 'briefWeekdaysOnly', label: 'Weekdays only', hint: 'Even a professor rests at the weekend. Applies to the morning brief.' },
  { key: 'hideOnFullscreen', label: 'Hide during fullscreen apps', hint: 'Games, films and presentations stay Clippy-free.' },
  { key: 'autoStart', label: 'Start with Windows', hint: 'Clippy turns up for work when you do.' },
];

/** Every `Settings` option: toggles, the default ask wait, standing orders, WhatsApp, Telegram, and Claude Code wiring. */
export function SettingsTab({ api, state }: { api: ClippyWindowApi; state: SettingsState }) {
  const { settings, update, error } = state;
  const [workerUrl, setWorkerUrl] = useState('');
  const [workerSecret, setWorkerSecret] = useState('');
  const [relayError, setRelayError] = useState<string>();

  const [askWait, setAskWait] = useState('');
  const [askWaitError, setAskWaitError] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus>();
  const [away, setAway] = useState('');
  const [awayError, setAwayError] = useState(false);
  const [hotkey, setHotkey] = useState('');
  const [hotkeyStatus, setHotkeyStatus] = useState<HotkeyStatus>();

  useEffect(() => {
    setWorkerUrl(settings?.workerUrl ?? '');
  }, [settings?.workerUrl]);
  useEffect(() => {
    if (settings) setAskWait(askWaitMinutes(settings.askTimeoutDefaultS));
  }, [settings?.askTimeoutDefaultS]);
  useEffect(() => {
    if (settings) setAway(awayMinutes(settings.awayThresholdS));
  }, [settings?.awayThresholdS]);

  // Main registers the shortcut when the setting changes; ask how that went.
  useEffect(() => {
    if (!settings) return;
    setHotkey(settings.tellHotkey);
    void api.hotkeyStatus().then(setHotkeyStatus, () => {});
  }, [api, settings?.tellHotkey]);

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

  /** Save the away threshold on blur / Enter, only if it's valid and changed. */
  const commitAway = () => {
    const seconds = parseAwayMinutes(away);
    if (seconds === undefined) {
      setAwayError(true);
      return;
    }
    setAwayError(false);
    setAway(awayMinutes(seconds));
    if (seconds !== settings.awayThresholdS) void update({ awayThresholdS: seconds });
  };

  /** Save the hotkey on blur / Enter if it changed. Anything goes in: main reports a bad one. */
  const commitHotkey = () => {
    const accelerator = hotkey.trim();
    setHotkey(accelerator);
    if (accelerator !== settings.tellHotkey) void update({ tellHotkey: accelerator });
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
        <Fragment key={key}>
          <label className="setting">
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
          {key === 'soundEnabled' && (
            <label className="setting">
              <span className="setting-text">
                <span className="setting-label">Pop up for</span>
                <span className="setting-hint">Anything else waits quietly under my unread badge.</span>
              </span>
              <select
                className="field-input setting-select"
                value={settings.popUpFor}
                aria-label="What makes me pop up"
                onChange={(e) => void update({ popUpFor: e.target.value as Settings['popUpFor'] })}
              >
                <option value="important">Questions, reminders &amp; urgent</option>
                <option value="everything">Everything</option>
              </select>
            </label>
          )}
          {key === 'briefEnabled' && (
            <label className="setting">
              <span className="setting-text">
                <span className="setting-label">Brief time</span>
                <span className="setting-hint">If the PC is off then, it comes when you are back, within two hours.</span>
              </span>
              <input
                type="time"
                className="field-input setting-select"
                value={settings.briefTime}
                aria-label="Time of the morning brief"
                disabled={!settings.briefEnabled}
                onChange={(e) => {
                  // An empty value is a half-typed time; the browser only reports a whole HH:MM.
                  if (e.target.value) void update({ briefTime: e.target.value });
                }}
              />
            </label>
          )}
          {key === 'hookEnabled' && (
            <>
              <label className="setting">
                <span className="setting-text">
                  <span className="setting-label">I count as away after</span>
                  <span className="setting-hint">No keyboard or mouse for this long. Agent-finished pings and phone messages wait for it. 0 = always away.</span>
                </span>
                <span className="setting-number">
                  <input
                    type="text"
                    inputMode="numeric"
                    className={`field-input${awayError ? ' field-input--bad' : ''}`}
                    value={away}
                    aria-label="Minutes before I count as away"
                    aria-invalid={awayError}
                    onChange={(e) => {
                      setAway(e.target.value);
                      setAwayError(false);
                    }}
                    onBlur={commitAway}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitAway();
                      if (e.key === 'Escape') setAway(awayMinutes(settings.awayThresholdS));
                    }}
                  />
                  min
                </span>
              </label>
              {awayError && <p className="card-error">Whole minutes from 0 to {AWAY_MAX_MINUTES}, please.</p>}
              <label className="setting">
                <span className="setting-text">
                  <span className="setting-label">Send to my phone</span>
                  <span className="setting-hint">Notes wait until you are away; a question left unanswered for 10 minutes goes anyway. WhatsApp reminders always go out on time.</span>
                </span>
                <select
                  className="field-input setting-select"
                  value={settings.phoneWhen}
                  aria-label="When notes are sent to my phone"
                  onChange={(e) => void update({ phoneWhen: e.target.value as Settings['phoneWhen'] })}
                >
                  <option value="away">Only when I'm away</option>
                  <option value="always">Always</option>
                </select>
              </label>
            </>
          )}
        </Fragment>
      ))}

      <label className="setting">
        <span className="setting-text">
          <span className="setting-label">Tell Clippy hotkey</span>
          <span className="setting-hint">Press it anywhere to type him an instruction. Empty = no hotkey.</span>
        </span>
        <input
          type="text"
          className={`field-input setting-select${hotkeyStatus && !hotkeyStatus.ok ? ' field-input--bad' : ''}`}
          value={hotkey}
          maxLength={60}
          placeholder="Control+Alt+Space"
          aria-label="Tell Clippy hotkey"
          aria-invalid={hotkeyStatus ? !hotkeyStatus.ok : false}
          onChange={(e) => setHotkey(e.target.value)}
          onBlur={commitHotkey}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitHotkey();
            if (e.key === 'Escape') setHotkey(settings.tellHotkey);
          }}
        />
      </label>
      {hotkeyStatus && !hotkeyStatus.ok && <p className="card-error">{hotkeyStatus.error}</p>}
      {hotkeyStatus?.ok && hotkeyStatus.accelerator && <p className="setting-hint">Ready: press {hotkeyStatus.accelerator} from anywhere.</p>}

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

      <RulesSection api={api} />

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
