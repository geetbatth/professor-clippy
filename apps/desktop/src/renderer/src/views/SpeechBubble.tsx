import { useEffect } from 'react';
import './SpeechBubble.css';

/** How long a quip stays up. */
const SHOW_MS = 9_000;

/** Clippy's speech bubble (a canned quip, or a tip for `ms`). Click to dismiss; it also leaves on its own. */
export function SpeechBubble({ text, ms = SHOW_MS, onDismiss }: { text: string; ms?: number; onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, ms);
    return () => clearTimeout(id);
  }, [text, ms, onDismiss]);
  return (
    <div className="bubble" data-solid="" role="status" onClick={onDismiss} title="Click to dismiss">
      <p>{text}</p>
    </div>
  );
}
