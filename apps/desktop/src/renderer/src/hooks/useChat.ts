import { useCallback, useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Message } from '@clippy/shared/schemas';

/** How many past chat lines to show when the tab opens. */
const HISTORY_LINES = 30;

/** Append `m` unless a line with its id is already there (lines arrive by several routes). */
const appendOnce = (lines: Message[], m: Message): Message[] => (lines.some((l) => l.id === m.id) ? lines : [...lines, m]);

export interface ChatState {
  lines: Message[];
  /** Clippy's reply so far, while it streams in. */
  streaming: string | undefined;
  /** The brain is working (from `brain:state`). */
  thinking: boolean;
  error: string | undefined;
  send(text: string): Promise<void>;
  newChat(): Promise<void>;
}

/** Chat with Clippy's brain: recent history, streamed replies and the brain's busy state. */
export function useChat(api: ClippyWindowApi): ChatState {
  const [lines, setLines] = useState<Message[]>([]);
  const [streaming, setStreaming] = useState<string>();
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    void api.listMessages({ kind: 'chat' }).then((list) => {
      if (!live) return;
      const recent = [...list].sort((a, b) => a.createdAt - b.createdAt).slice(-HISTORY_LINES);
      setLines((current) => [...recent.filter((m) => !current.some((c) => c.id === m.id)), ...current]);
    });
    const offs = [
      api.on('brain:state', (s) => setThinking(s === 'thinking')),
      api.on('chat:delta', (d) => setStreaming((s) => (s ?? '') + d.text)),
      // A failed turn also clears any partial reply that had streamed in; the error shows instead.
      api.on('chat:done', (d) => {
        setStreaming(undefined);
        if (d.message) setLines((l) => appendOnce(l, d.message!));
        setError(d.error);
      }),
      // The user's own lines, including ones sent from WhatsApp while this tab is open.
      api.on('message:new', (m) => {
        if (m.kind === 'chat' && m.role === 'user') setLines((l) => appendOnce(l, m));
      }),
    ];
    return () => {
      live = false;
      offs.forEach((off) => off());
    };
  }, [api]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setError(undefined);
      try {
        const mine = await api.sendChat(trimmed);
        setLines((l) => appendOnce(l, mine));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [api],
  );

  const newChat = useCallback(async () => {
    await api.newChat();
    setLines([]);
    setStreaming(undefined);
    setError(undefined);
  }, [api]);

  return { lines, streaming, thinking, error, send, newChat };
}
