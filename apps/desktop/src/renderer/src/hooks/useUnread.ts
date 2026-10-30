import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Message } from '@clippy/shared/schemas';
import { applyToStack, buildStack } from '../note/unreadStack';

export interface UnreadStack {
  messages: Message[];
  markDone(id: string): Promise<void>;
  snooze(id: string, until: number): Promise<void>;
  answer(id: string, text: string): Promise<void>;
}

/**
 * The unread stack, kept live from `message:new` / `message:updated`.
 * `onNew` fires for each new stack-worthy message (for the quip, sound and antics).
 */
export function useUnread(api: ClippyWindowApi, onNew: (m: Message) => void): UnreadStack {
  const [messages, setMessages] = useState<Message[]>([]);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;

  useEffect(() => {
    let live = true;
    void api.listMessages({ state: 'unread' }).then((list) => {
      if (live) setMessages((current) => list.reduce(applyToStack, buildStack(current)));
    });
    const offNew = api.on('message:new', (m) => {
      setMessages((s) => applyToStack(s, m));
      if (m.state === 'unread' && m.kind !== 'chat') onNewRef.current(m);
    });
    const offUpdated = api.on('message:updated', (m) => setMessages((s) => applyToStack(s, m)));
    return () => {
      live = false;
      offNew();
      offUpdated();
    };
  }, [api]);

  // Actions also apply the returned message, in case the update event is slow or missing.
  const markDone = useCallback(
    async (id: string) => {
      const m = await api.markDone(id);
      setMessages((s) => applyToStack(s, m));
    },
    [api],
  );
  const snooze = useCallback(
    async (id: string, until: number) => {
      const m = await api.snooze(id, until);
      setMessages((s) => applyToStack(s, m));
    },
    [api],
  );
  const answer = useCallback(
    async (id: string, text: string) => {
      await api.answerAsk(id, text);
    },
    [api],
  );

  return { messages, markDone, snooze, answer };
}
