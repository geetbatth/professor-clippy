/**
 * Voice for the whole note: the speech models' status, transcribing a desk recording, and one
 * shared player for the speaker buttons (starting one stops the other).
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ClippyWindowApi, VoiceStatus } from '@clippy/shared/ipc';

export { voiceUnavailable } from './voiceUnavailable';

export interface VoiceApi {
  /** Undefined until loaded. */
  status: VoiceStatus | undefined;
  /** Voice is on and the models are here. */
  ready: boolean;
  download(): void;
  transcribe(pcm: Float32Array): Promise<string>;
  /** The key of the speaker button playing (or loading) now. */
  playing: string | undefined;
  loading: string | undefined;
  /** Read `text` aloud for button `key`; a second press on the same button stops it. */
  toggleSpeak(key: string, text: string): Promise<void>;
}

const VoiceCtx = createContext<VoiceApi | undefined>(undefined);

export function useVoice(): VoiceApi | undefined {
  return useContext(VoiceCtx);
}

export function VoiceProvider({ api, children }: { api: ClippyWindowApi; children: ReactNode }) {
  const [status, setStatus] = useState<VoiceStatus>();
  const [playing, setPlaying] = useState<string>();
  const [loading, setLoading] = useState<string>();
  const audio = useRef<{ el: HTMLAudioElement; url: string; key: string }>(undefined);
  /** Bumped by every press, so a slow voiceSpeak that was overtaken doesn't play. */
  const turn = useRef(0);

  useEffect(() => {
    let live = true;
    api.voiceStatus().then((s) => live && setStatus(s), () => {});
    const off = api.on('voice:status', setStatus);
    return () => {
      live = false;
      off();
    };
  }, [api]);

  const stopAudio = useCallback(() => {
    const a = audio.current;
    if (!a) return;
    a.el.pause();
    URL.revokeObjectURL(a.url);
    audio.current = undefined;
    setPlaying(undefined);
  }, []);
  useEffect(() => stopAudio, [stopAudio]);

  const toggleSpeak = useCallback(
    async (key: string, text: string) => {
      const mine = ++turn.current;
      const wasThis = audio.current?.key === key || loading === key;
      stopAudio();
      setLoading(undefined);
      if (wasThis) return;
      setLoading(key);
      try {
        const wav = await api.voiceSpeak(text);
        if (mine !== turn.current) return;
        const url = URL.createObjectURL(new Blob([wav as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }));
        const el = new Audio(url);
        audio.current = { el, url, key };
        el.onended = () => {
          if (audio.current?.el === el) stopAudio();
        };
        setPlaying(key);
        await el.play();
      } finally {
        if (mine === turn.current) setLoading(undefined);
      }
    },
    [api, loading, stopAudio],
  );

  const value = useMemo<VoiceApi>(
    () => ({
      status,
      ready: status?.enabled === true && status.state === 'ready',
      download: () => void api.voiceDownload().then(setStatus, () => {}),
      transcribe: (pcm) => api.voiceTranscribe(pcm, 16_000),
      playing,
      loading,
      toggleSpeak,
    }),
    [api, status, playing, loading, toggleSpeak],
  );
  return <VoiceCtx.Provider value={value}>{children}</VoiceCtx.Provider>;
}
