import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '../hooks/useChat';
import type { ClippyWindowShell } from '../../../main/window/windowApi';
import { tellReply } from './tellReply';
import './TellBox.css';

export interface TellBoxProps {
  /** The one shared brain session: the same chat the Clippy tab shows. */
  chat: ChatState;
  shell: ClippyWindowShell;
  /** The hotkey was pressed: take focus, then call `onFocused`. */
  wantFocus: boolean;
  onFocused(): void;
  /** True while the box has focus or text, so the note doesn't tuck itself away mid-sentence. */
  onActive(active: boolean): void;
  /** Escape: tuck Clippy away. */
  onCollapse(): void;
}

/** A one-line "Tell Clippy…" input pinned under the notes, with his reply to that line below it. */
export function TellBox({ chat, shell, wantFocus, onFocused, onActive, onCollapse }: TellBoxProps) {
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  /** When the last line was sent from here; unset once the answer is cleared. */
  const [sentAt, setSentAt] = useState<number>();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!wantFocus) return;
    inputRef.current?.focus();
    onFocused();
  }, [wantFocus, onFocused]);

  const active = focused || draft !== '';
  useEffect(() => {
    onActive(active);
    return () => onActive(false);
  }, [active, onActive]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    setSentAt(Date.now());
    void chat.send(text);
  };

  const reply = sentAt === undefined ? undefined : tellReply(chat.lines, sentAt);
  const answer = sentAt === undefined ? undefined : chat.streaming ?? reply?.body;

  return (
    <div className="tell">
      <input
        ref={inputRef}
        className="tell-input"
        type="text"
        value={draft}
        placeholder="Tell Clippy… (e.g. remind me at 3 to call Dave)"
        aria-label="Tell Clippy"
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft('');
            setSentAt(undefined);
            shell.blur();
            onCollapse();
          }
        }}
      />
      {sentAt !== undefined && (
        <div className="tell-reply" role="status">
          {chat.error ? (
            <p className="card-error">Clippy dropped his chalk: {chat.error}</p>
          ) : answer !== undefined ? (
            <p className={`tell-text${chat.streaming !== undefined ? ' tell-text--live' : ''}`}>{answer}</p>
          ) : (
            <p className="tell-text tell-text--wait">Clippy is thinking…</p>
          )}
          <button className="tell-clear" type="button" aria-label="Clear" title="Clear" onClick={() => setSentAt(undefined)}>
            ×
          </button>
        </div>
      )}
    </div>
  );
}
