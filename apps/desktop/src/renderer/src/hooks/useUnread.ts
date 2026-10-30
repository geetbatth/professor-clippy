import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClippyWindowApi } from '@clippy/shared/ipc';
import type { Message } from '@clippy/shared/schemas';
import { applyToStack, buildStack, isArrival } from '../note/unreadStack';

export interface UnreadStack {
  messages: Message[];
  markDone(id: string): Promise<void>;
  snooze(id: string, until: number): Promise<void>;
  answer(id: string, text: string): Promise<void>;
}

/**
 * The unread stack, kept live from `message:new` / `message:updated`.
 * `onNew` fires for each message that arrives on the stack (for the quip, sound and antics),
 * including snoozed notes coming back.
 */
export function useUnread(api: ClippyWindowApi, onNew: (m: Message) => void): UnreadStack {
  const [messages, setMessagesState] = useState<Message[]>([]);
  const onNewRef = useRef(onNew);
  onNewRef.current = onNew;
  // Mirror of the stack, so event handlers can tell arrivals from updates without side effects in updaters.
  const stackRef = useRef<Message[]>([]);
  const setMessages = useCallback((update: (s: Message[]) => Message[]) => {
    stackRef.current = update(stackRef.current);
    setMessagesState(stackRef.current);
  }, []);

  useEffect(() => {
    let live = true;
    void api.listMessages({ state: 'unread' }).then((list) => {
      if (live) setMessages((current) => list.reduce(applyToStack, buildStack(current)));
    });
    const onEvent = (m: Message) => {
      const arrived = isArrival(stackRef.current, m);
      setMessages((s) => applyToStack(s, m));
      if (arrived) onNewRef.current(m);
    };
    const offNew = api.on('message:new', onEvent);
    const offUpdated = api.on('message:updated', onEvent);
    return () => {
      live = false;
      offNew();
      offUpdated();
    };
  }, [api, setMessages]);

  // Actions also apply the returned message, in case the update event is slow or missing.
  const markDone = useCallback(
    async (id: string) => {
      const m = await api.markDone(id);
      setMessages((s) => applyToStack(s, m));
    },
    [api, setMessages],
  );
  const snooze = useCallback(
    async (id: string, until: number) => {
      const m = await api.snooze(id, until);
      setMessages((s) => applyToStack(s, m));
    },
    [api, setMessages],
  );
  const answer = useCallback(
    async (id: string, text: string) => {
      await api.answerAsk(id, text);
    },
    [api],
  );

  return { messages, markDone, snooze, answer };
}
