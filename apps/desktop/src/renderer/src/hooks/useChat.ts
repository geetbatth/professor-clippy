import { useCallback, useEffect, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Message } from '@clippy/shared/schemas';

/** How many past chat lines to show when the tab opens. */
const HISTORY_LINES = 30;

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
      api.on('chat:done', (d) => {
        setStreaming(undefined);
        if (d.message) setLines((l) => [...l, d.message!]);
        setError(d.error);
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
        setLines((l) => [...l, mine]);
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
