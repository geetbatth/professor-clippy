import { useEffect } from 'react';
import './SpeechBubble.css';

/** How long a quip stays up. */
const SHOW_MS = 9_000;

/** Clippy's speech bubble (one canned quip). Click to dismiss; it also leaves on its own. */
export function SpeechBubble({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDismiss, SHOW_MS);
    return () => clearTimeout(id);
  }, [text, onDismiss]);
  return (
    <div className="bubble" data-solid="" role="status" onClick={onDismiss} title="Click to dismiss">
      <p>{text}</p>
    </div>
  );
}
