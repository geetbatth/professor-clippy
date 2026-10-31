import { useState } from 'react';
import { useVoice } from './VoiceContext';
import './voice.css';

/**
 * A small speaker that reads `text` aloud in Clippy's voice. Hidden while voice is off; before
 * the models are downloaded, a press starts the download (and says so).
 */
export function SpeakButton({ id, text }: { id: string; text: string }) {
  const voice = useVoice();
  const [error, setError] = useState<string>();
  if (!voice?.status?.enabled || !text.trim()) return null;
  const playing = voice.playing === id;
  const loading = voice.loading === id;
  const downloading = voice.status.state === 'downloading';
  const label = playing ? 'Stop' : loading ? 'Getting ready to read it…' : downloading ? 'Clippy’s voice is downloading' : 'Read it aloud';
  return (
    <button
      type="button"
      className={`speak${playing ? ' speak--on' : ''}${loading ? ' speak--loading' : ''}`}
      aria-label={label}
      title={error ?? label}
      onClick={(e) => {
        e.stopPropagation();
        setError(undefined);
        voice.toggleSpeak(id, text).catch((err: unknown) => setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (\w+: )?/, '') : String(err)));
      }}
    >
      {playing ? '■' : loading ? '…' : downloading ? `${Math.round((voice.status.progress ?? 0) * 100)}%` : '🔈'}
      {error && <span className="speak-error">{error}</span>}
    </button>
  );
}
