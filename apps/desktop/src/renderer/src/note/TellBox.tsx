import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatState } from '../hooks/useChat';
import type { ClippyWindowShell } from '../../../main/window/windowApi';
import { startRecording, RECORD_RATE, type Recording } from '../voice/recorder';
import { SpeakButton } from '../voice/SpeakButton';
import { useVoice, voiceUnavailable } from '../voice/VoiceContext';
import { tellReply } from './tellReply';
import './TellBox.css';

/** Held this long, the Tell hotkey means "listen" rather than "type". */
export const HOLD_MS = 300;
/** Shorter than this, a recording is a slip of the finger. */
const MIN_RECORDING_S = 0.4;

export interface TellBoxProps {
  /** The one shared brain session: the same chat the Clippy tab shows. */
  chat: ChatState;
  shell: ClippyWindowShell;
  /** The hotkey was pressed: take focus, then call `onFocused`. */
  wantFocus: boolean;
  onFocused(): void;
  /** Counts hotkey presses: holding the hotkey (rather than tapping it) records a voice line. */
  tellPresses?: number;
  /** True while the box has focus or text, so the note doesn't tuck itself away mid-sentence. */
  onActive(active: boolean): void;
  /** Escape: tuck Clippy away. */
  onCollapse(): void;
  /** A line was sent (Getting started's "hotkey" item, and the tips). */
  onSend?(text: string): void;
}

type Listen = 'idle' | 'recording' | 'transcribing';

/** A one-line "Tell Clippy…" input pinned under the notes, with his reply to that line below it. */
export function TellBox({ chat, shell, wantFocus, onFocused, tellPresses = 0, onActive, onCollapse, onSend }: TellBoxProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  /** When the last line was sent from here; unset once the answer is cleared. */
  const [sentAt, setSentAt] = useState<number>();
  const [listen, setListen] = useState<Listen>('idle');
  /** Why the mic can't listen (models downloading, no microphone...), shown under the box. */
  const [notice, setNotice] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const micRef = useRef<HTMLButtonElement>(null);
  const voice = useVoice();

  useEffect(() => {
    if (!wantFocus) return;
    inputRef.current?.focus();
    onFocused();
  }, [wantFocus, onFocused]);

  const active = focused || draft !== '' || listen !== 'idle';
  useEffect(() => {
    onActive(active);
    return () => onActive(false);
  }, [active, onActive]);

  const sendText = useCallback(
    (raw: string) => {
      const text = raw.trim();
      if (!text) return;
      setDraft('');
      setSentAt(Date.now());
      void chat.send(text);
      onSend?.(text);
    },
    [chat, onSend],
  );
  const send = () => sendText(draft);

  // ---- the mic ------------------------------------------------------------
  const rec = useRef<Recording>(undefined);
  /** A stop asked for while the mic was still starting. */
  const stopWanted = useRef(false);
  const starting = useRef(false);
  const latest = useRef({ voice, sendText });
  latest.current = { voice, sendText };

  const finish = useCallback(async () => {
    const r = rec.current;
    if (!r) {
      if (starting.current) stopWanted.current = true;
      return;
    }
    rec.current = undefined;
    const pcm = await r.stop();
    if (pcm.length < MIN_RECORDING_S * RECORD_RATE) {
      setListen('idle');
      return;
    }
    setListen('transcribing');
    try {
      const text = (await latest.current.voice?.transcribe(pcm)) ?? '';
      if (text.trim()) latest.current.sendText(text);
      else setNotice('I didn’t catch any words. Try again, a little closer to the mic?');
    } catch (err) {
      setNotice(cleanError(err));
    } finally {
      setListen('idle');
    }
  }, []);

  const begin = useCallback(async () => {
    if (rec.current || starting.current) return;
    const v = latest.current.voice;
    const why = voiceUnavailable(v?.status);
    if (why) {
      setNotice(why);
      if (v?.status?.enabled && (v.status.state === 'missing' || v.status.state === 'error')) v.download();
      return;
    }
    setNotice(undefined);
    starting.current = true;
    stopWanted.current = false;
    try {
      rec.current = await startRecording(() => void finish());
      setListen('recording');
      if (stopWanted.current) void finish();
    } catch (err) {
      setNotice(`Clippy can’t hear you: ${err instanceof DOMException && err.name === 'NotAllowedError' ? 'the microphone is blocked (Windows Settings → Privacy → Microphone).' : err instanceof DOMException && err.name === 'NotFoundError' ? 'no microphone was found.' : cleanError(err)}`);
    } finally {
      starting.current = false;
    }
  }, [finish]);

  const cancel = useCallback(() => {
    rec.current?.cancel();
    rec.current = undefined;
    stopWanted.current = starting.current;
    setListen('idle');
  }, []);
  useEffect(() => cancel, [cancel]);

  // The mic pulses with your voice.
  useEffect(() => {
    if (listen !== 'recording') return;
    let frame = requestAnimationFrame(function tick() {
      micRef.current?.style.setProperty('--mic-level', String(rec.current?.level() ?? 0));
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [listen]);

  // Hold the Tell hotkey to talk: a tap focuses the box for typing as before; still held after
  // HOLD_MS, it listens until the keys are let go. Repeats while held are ignored.
  const hold = useRef<{ timer: number; listening: boolean }>(undefined);
  useEffect(() => {
    if (tellPresses === 0 || hold.current || rec.current) return;
    const h = {
      listening: false,
      timer: window.setTimeout(() => {
        if (hold.current !== h || !latest.current.voice?.status?.enabled) {
          if (hold.current === h) hold.current = undefined;
          return;
        }
        h.listening = true;
        void begin();
      }, HOLD_MS),
    };
    hold.current = h;
  }, [tellPresses, begin]);
  useEffect(() => {
    const up = () => {
      const h = hold.current;
      if (!h) return;
      hold.current = undefined;
      if (h.listening) void finish();
      else clearTimeout(h.timer); // a tap: type
    };
    // Keys held from the hotkey must not type into the box.
    const down = (e: KeyboardEvent) => {
      if (hold.current && (e.ctrlKey || e.altKey || e.metaKey)) e.preventDefault();
    };
    window.addEventListener('keyup', up, true);
    window.addEventListener('keydown', down, true);
    return () => {
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('keydown', down, true);
    };
  }, [finish]);

  const reply = sentAt === undefined ? undefined : tellReply(chat.lines, sentAt);
  const answer = sentAt === undefined ? undefined : chat.streaming ?? reply?.body;
  const showMic = voice?.status?.enabled === true;

  return (
    <div className="tell">
      <div className="tell-row">
        <input
          ref={inputRef}
          className="tell-input"
          type="text"
          value={draft}
          placeholder={listen === 'recording' ? 'Listening… (let go or click the mic to send)' : listen === 'transcribing' ? 'Listening back…' : 'Tell Clippy… (e.g. remind me at 3 to call Dave)'}
          aria-label="Tell Clippy"
          readOnly={listen !== 'idle'}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (listen === 'recording') void finish();
              else send();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (listen === 'recording') {
                cancel();
                return;
              }
              setDraft('');
              setSentAt(undefined);
              setNotice(undefined);
              shell.blur();
              onCollapse();
            }
          }}
        />
        {showMic && (
          <button
            ref={micRef}
            type="button"
            className={`tell-mic${listen === 'recording' ? ' tell-mic--on' : ''}${listen === 'transcribing' ? ' tell-mic--busy' : ''}`}
            aria-label={listen === 'recording' ? 'Stop and send' : 'Talk to Clippy'}
            title={listen === 'recording' ? 'Stop and send (Esc cancels)' : 'Talk to Clippy (or hold the Tell hotkey)'}
            disabled={listen === 'transcribing'}
            onClick={() => (listen === 'recording' ? void finish() : void begin())}
          >
            {listen === 'recording' ? '■' : listen === 'transcribing' ? '…' : '🎙'}
          </button>
        )}
      </div>
      {notice && listen === 'idle' && (
        <p className="tell-listening" role="status">
          {notice}
        </p>
      )}
      {sentAt !== undefined && (
        <div className="tell-reply" role="status">
          {chat.error ? (
            <p className="card-error">Clippy dropped his chalk: {chat.error}</p>
          ) : answer !== undefined ? (
            <p className={`tell-text${chat.streaming !== undefined ? ' tell-text--live' : ''}`}>{answer}</p>
          ) : (
            <p className="tell-text tell-text--wait">Clippy is thinking…</p>
          )}
          {reply && chat.streaming === undefined && (
            <div className="reply-tools">
              <SpeakButton id={`tell-${reply.id}`} text={reply.body} />
            </div>
          )}
          <button className="tell-clear" type="button" aria-label="Clear" title="Clear" onClick={() => setSentAt(undefined)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** An IPC error without Electron's "Error invoking remote method" wrapper. */
export function cleanError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.replace(/^Error invoking remote method '[^']+': (?:\w*Error: )?/, '');
}
