import { useEffect, useRef, useState } from 'react';
import type { ChatState } from '../hooks/useChat';
import './ChatTab.css';

/** Chat with Clippy's brain: bubbles, the reply streaming in, an input box and "New chat". */
export function ChatTab({ chat }: { chat: ChatState }) {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const lines = [...chat.lines].sort((a, b) => a.createdAt - b.createdAt);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [chat.lines.length, chat.streaming, chat.thinking]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void chat.send(text);
  };

  return (
    <div className="chat">
      <div className="chat-toolbar">
        <button className="btn btn-ghost" onClick={() => void chat.newChat()} title="Forget this conversation and start afresh">
          ✎ New chat
        </button>
      </div>
      <div className="chat-log">
        {lines.length === 0 && !chat.streaming && (
          <div className="chat-hint">
            <p>Tell me what to do. For instance:</p>
            <ul>
              <li>remind me at 3 to call Dave</li>
              <li>what are my agents waiting on?</li>
              <li>when the build finishes, remind me to deploy</li>
            </ul>
          </div>
        )}
        {lines.map((m) => (
          <div key={m.id} className={`chat-line chat-line--${m.role === 'user' ? 'user' : 'clippy'}`}>
            <p>{m.body}</p>
          </div>
        ))}
        {chat.streaming !== undefined && (
          <div className="chat-line chat-line--clippy chat-line--live">
            <p>{chat.streaming}</p>
          </div>
        )}
        {chat.thinking && chat.streaming === undefined && (
          <div className="chat-line chat-line--clippy chat-typing" aria-label="Clippy is thinking">
            <span />
            <span />
            <span />
          </div>
        )}
        {chat.error && <p className="card-error">Clippy dropped his chalk: {chat.error}</p>}
        <div ref={endRef} />
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <textarea
          value={draft}
          rows={2}
          placeholder="Tell Clippy what to do…"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn btn-done" type="submit" disabled={!draft.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}
