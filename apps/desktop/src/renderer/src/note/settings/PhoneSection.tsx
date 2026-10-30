import { useEffect, useState } from 'react';
import type { TelegramStatus } from '@clippy/shared/ipc';
import type { Settings } from '@clippy/shared/settings';
import { AWAY_MAX_MINUTES, awayMinutes, parseAwayMinutes } from '../awayThreshold';
import { relayBadge, relayPatch } from '../firstRun';
import { TelegramBadge, TelegramSetup } from '../TelegramSetup';
import { GroupLabel, MenuRow, Pill, SettingRow, type SectionProps } from './controls';

type Channel = 'telegram' | 'relay';

/**
 * Settings → Phone: when notes go to the phone, when you count as away, and where they go
 * (Telegram, the WhatsApp relay), each a row that unfolds its setup.
 */
export function PhoneSection({ api, settings, update }: SectionProps) {
  const [away, setAway] = useState(() => awayMinutes(settings.awayThresholdS));
  const [awayError, setAwayError] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus>();
  const [open, setOpen] = useState<Channel>();

  useEffect(() => {
    setAway(awayMinutes(settings.awayThresholdS));
  }, [settings.awayThresholdS]);
  // For the Telegram row's badge; the setup polls it once unfolded.
  useEffect(() => {
    let live = true;
    void api.telegramStatus().then((s) => live && setTelegram(s), () => {});
    return () => {
      live = false;
    };
  }, [api]);

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

  const toggle = (channel: Channel) => setOpen((o) => (o === channel ? undefined : channel));
  const relaySaved = relayBadge(settings) === 'saved';

  return (
    <>
      <SettingRow
        label="Send to my phone"
        hint="Notes wait until you are away; a question left waiting goes anyway after half the time agents wait for your answer (5 minutes by default). WhatsApp reminders always go out on time."
      >
        <select
          className="field-input setting-select"
          value={settings.phoneWhen}
          aria-label="When notes are sent to my phone"
          onChange={(e) => void update({ phoneWhen: e.target.value as Settings['phoneWhen'] })}
        >
          <option value="away">Only when I'm away</option>
          <option value="always">Always</option>
        </select>
      </SettingRow>
      <SettingRow label="I count as away after" hint="No keyboard or mouse for this long. Agent-finished pings and phone messages wait for it. 0 = always away.">
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
      </SettingRow>
      {awayError && <p className="card-error">Whole minutes from 0 to {AWAY_MAX_MINUTES}, please.</p>}

      <GroupLabel>Where it goes</GroupLabel>
      <MenuRow
        icon="✈️"
        title="Telegram"
        summary="Notes, reminders and questions on your phone through your own bot, no Worker needed."
        pill={<TelegramBadge status={telegram} />}
        open={open === 'telegram'}
        onClick={() => toggle('telegram')}
      />
      {open === 'telegram' && (
        <div className="settings-unfold">
          <TelegramSetup api={api} update={update} onStatus={setTelegram} />
        </div>
      )}
      <MenuRow
        icon="💬"
        title="WhatsApp relay"
        summary="Through Meta's WhatsApp Cloud API and a Cloudflare Worker you deploy yourself."
        pill={
          relaySaved ? (
            <Pill on title="Worker URL and secret saved. Messages go out while the Worker is reachable.">
              saved
            </Pill>
          ) : (
            <Pill on={false}>off</Pill>
          )
        }
        open={open === 'relay'}
        onClick={() => toggle('relay')}
      />
      {open === 'relay' && (
        <div className="settings-unfold">
          <RelayFields settings={settings} update={update} />
        </div>
      )}
    </>
  );
}

/** The WhatsApp relay's Worker URL and secret, with Save and Disconnect (here and in the welcome). */
export function RelayFields({ settings, update }: Omit<SectionProps, 'api'>) {
  const [workerUrl, setWorkerUrl] = useState(settings.workerUrl ?? '');
  const [workerSecret, setWorkerSecret] = useState('');
  const [relayError, setRelayError] = useState<string>();

  useEffect(() => {
    setWorkerUrl(settings.workerUrl ?? '');
  }, [settings.workerUrl]);

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
    <>
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
      {relayError && <p className="card-error">{relayError}</p>}
    </>
  );
}
