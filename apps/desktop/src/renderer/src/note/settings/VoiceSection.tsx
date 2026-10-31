import type { Settings } from '@clippy/shared/settings';
import { hotkeyLabel } from './summaries';
import { SettingRow, ToggleSetting, type SectionProps } from './controls';
import { useVoice } from '../../voice/VoiceContext';
import { SpeakButton } from '../../voice/SpeakButton';

/** Settings → Voice: on or off, and the one-time download of the speech models. */
export function VoiceSection({ settings, update }: SectionProps) {
  const voice = useVoice();
  const status = voice?.status;
  const hotkey = settings.tellHotkey ? hotkeyLabel(settings.tellHotkey) : undefined;
  return (
    <>
      <ToggleSetting name="voiceEnabled" settings={settings} update={update} />
      {settings.voiceEnabled && (
        <SettingRow label="Voice replies on my phone" hint="My answers come as a voice note, with the text as its caption. Very long ones come as text.">
          <select
            className="field-input setting-select"
            value={settings.voiceReplies}
            aria-label="When my phone replies are voice notes"
            onChange={(e) => void update({ voiceReplies: e.target.value as Settings['voiceReplies'] })}
          >
            <option value="voice-notes">When I send a voice note</option>
            <option value="always">Always</option>
          </select>
        </SettingRow>
      )}
      {settings.voiceEnabled && status && (
        <SettingRow
          label="Clippy's ears and voice"
          hint={
            status.state === 'ready'
              ? 'Downloaded. Speech is understood and spoken on this PC; nothing is sent anywhere.'
              : status.state === 'downloading'
                ? `Downloading… ${Math.round((status.progress ?? 0) * 100)}% of ${status.downloadMb} MB. You can keep using Clippy meanwhile.`
                : status.state === 'error'
                  ? `The download failed: ${status.error ?? 'unknown error'}`
                  : `A one-time download of about ${status.downloadMb} MB (a speech model and a voice). It also starts the first time you talk to me.`
          }
        >
          {status.state === 'ready' ? (
            <SpeakButton id="settings-sample" text="Hello! I'm Professor Clippy. Hold the Tell hotkey and talk to me, or send me a voice note from your phone." />
          ) : (
            <button type="button" className="btn" disabled={status.state === 'downloading'} onClick={() => voice?.download()}>
              {status.state === 'downloading' ? `${Math.round((status.progress ?? 0) * 100)}%` : status.state === 'error' ? 'Try again' : 'Download'}
            </button>
          )}
        </SettingRow>
      )}
      {settings.voiceEnabled && (
        <p className="setting-hint">
          At the desk: click 🎙 by the Tell box{hotkey ? `, or hold ${hotkey}` : ''}, and talk; let go to send. The 🔈 on my replies reads
          them aloud. On your phone: send me a voice note and I answer with one{settings.voiceReplies === 'always' ? ', and I answer everything else aloud too' : ''}.
        </p>
      )}
    </>
  );
}
