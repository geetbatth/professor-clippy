import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Message } from '@clippy/shared/schemas';
import type { Settings } from '@clippy/shared/settings';
import type { WindowMode } from '../../main/window/windowApi';
import { TrackingClippy } from './clippy/TrackingClippy';
import { useClippyMood, type ClippyMood } from './clippy/useClippyMood';
import { useAdvice } from './hooks/useAdvice';
import { useAutoCollapse } from './hooks/useAutoCollapse';
import { useChat } from './hooks/useChat';
import { useClickThrough } from './hooks/useClickThrough';
import { useSettings } from './hooks/useSettings';
import { useUnread } from './hooks/useUnread';
import { useWindowDrag } from './hooks/useWindowDrag';
import { alertLevel, loudCount } from './note/alertLevel';
import { ChatTab } from './note/ChatTab';
import { FirstRunWizard } from './note/FirstRunWizard';
import { HistoryTab } from './note/HistoryTab';
import { NotesTab } from './note/NotesTab';
import { SettingsTab } from './note/SettingsTab';
import { StickyNote, type Tab } from './note/StickyNote';
import { TellBox } from './note/TellBox';
import { pickQuip, quipForMessage } from './quips/pickQuip';
import type { Runtime } from './runtime';
import { createSoundBoard } from './sound/sounds';
import { BrowserFrame } from './views/BrowserFrame';
import { ExpandedView } from './views/ExpandedView';
import { MiniView } from './views/MiniView';
import { SpeechBubble } from './views/SpeechBubble';

/** The open note tucks itself away after this long with nothing to show and nobody about. */
const AUTO_COLLAPSE_MS = 2 * 60_000;
const TABS: readonly Tab[] = ['notes', 'chat', 'history', 'settings'];

export function App({ runtime }: { runtime: Runtime }) {
  const { api, shell } = runtime;
  // Dev/screenshot hooks: ?mode=expanded&tab=chat
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [mode, setModeState] = useState<WindowMode>(params.get('mode') === 'expanded' ? 'expanded' : 'mini');
  const [tab, setTab] = useState<Tab>(TABS.find((t) => t === params.get('tab')) ?? 'notes');
  const [quip, setQuip] = useState<string>();
  const [wiggle, setWiggle] = useState(0);
  /** The hotkey asked for the Tell Clippy box; cleared once it has taken focus. */
  const [wantTellFocus, setWantTellFocus] = useState(false);
  /** The Tell Clippy box has focus or text: the note must not tuck itself away. */
  const tellActive = useRef(false);

  const settingsState = useSettings(api);
  const { settings } = settingsState;
  const { refresh: refreshSettings } = settingsState;
  // Opening Settings shows the current values (the tray can change sounds behind our back).
  useEffect(() => {
    if (tab === 'settings') refreshSettings();
  }, [tab, refreshSettings]);
  const soundOn = useRef(true);
  soundOn.current = settings?.soundEnabled ?? true;
  const popUpFor = useRef<Settings['popUpFor']>('important');
  popUpFor.current = settings?.popUpFor ?? 'important';
  const sounds = useMemo(() => createSoundBoard(() => soundOn.current), []);
  const chat = useChat(api);

  const modeRef = useRef(mode);
  modeRef.current = mode;
  const moodRef = useRef<ClippyMood>(null);
  const lastActivity = useRef(Date.now());
  /** True while Clippy or the note is being dragged. */
  const draggingRef = useRef(false);
  /** Fresh install: the note opens on the setup wizard until it is finished or skipped. */
  const firstRun = settings !== undefined && !settings.firstRunDone;

  const setMode = useCallback(
    (m: WindowMode) => {
      setModeState(m);
      shell.setMode(m);
      if (m === 'mini') setQuip(undefined);
    },
    [shell],
  );
  useEffect(() => shell.setMode(modeRef.current), [shell]);
  useEffect(() => shell.onModeChanged(setModeState), [shell]);
  useEffect(
    () =>
      shell.onTell(() => {
        setTab('notes');
        setWantTellFocus(true);
      }),
    [shell],
  );
  const tellFocused = useCallback(() => setWantTellFocus(false), []);
  const setTellActive = useCallback((active: boolean) => {
    tellActive.current = active;
  }, []);
  useEffect(() => {
    if (firstRun) setMode('expanded');
  }, [firstRun, setMode]);

  /**
   * Pop the note open (if tucked away) on the Notes tab. Not mid-drag: switching views would
   * pull the dragged Clippy out from under the cursor (the unread badge still shows).
   */
  const open = useCallback(() => {
    if (draggingRef.current) return;
    if (modeRef.current === 'mini') {
      setTab('notes');
      setMode('expanded');
    }
  }, [setMode]);

  const onNewMessage = useCallback(
    (m: Message) => {
      // Quiet arrivals only show up as the unread badge and in the stack.
      if (alertLevel(m, popUpFor.current) === 'quiet') return;
      moodRef.current?.message(m.urgent);
      sounds.play('ding');
      setQuip((last) => quipForMessage(m, new Date(), Math.random, last));
      setWiggle((w) => w + 1);
      lastActivity.current = Date.now();
      open();
    },
    [sounds, open],
  );
  const stack = useUnread(api, onNewMessage);
  const unread = stack.messages.length;
  const loud = loudCount(stack.messages, popUpFor.current);

  // Only loud notes make him read, nag (tap, boing) or wake; quiet ones are just the badge.
  const mood = useClippyMood({ unread: loud, thinking: chat.thinking, expanded: mode === 'expanded' });
  moodRef.current = mood;

  // Antics come with sound effects.
  useEffect(() => {
    if (mood.mood === 'tapGlass') sounds.play('tap');
    else if (mood.mood === 'jump' && mood.big) sounds.play('boing');
  }, [mood.seq, mood.mood, mood.big, sounds]);

  const activity = useCallback(() => {
    lastActivity.current = Date.now();
    moodRef.current?.activity();
  }, []);
  useEffect(() => {
    const events = ['pointerdown', 'keydown', 'wheel'] as const;
    events.forEach((e) => window.addEventListener(e, activity, { passive: true }));
    return () => events.forEach((e) => window.removeEventListener(e, activity));
  }, [activity]);

  useClickThrough(shell, draggingRef, activity);
  const toggleMode = useCallback(() => setMode(modeRef.current === 'mini' ? 'expanded' : 'mini'), [setMode]);
  const clippyDrag = useWindowDrag(shell, draggingRef, toggleMode);
  const noteDrag = useWindowDrag(shell, draggingRef);

  useAdvice(settings?.unsolicitedAdvice ?? false, () => {
    setQuip((last) => pickQuip('advice', Math.random, last));
    moodRef.current?.message(false);
    open();
  });
  // Quiet notes (the badge only) do not keep the note open; loud ones do.
  useAutoCollapse(mode === 'expanded' && loud === 0 && !chat.thinking && !firstRun, lastActivity, AUTO_COLLAPSE_MS, () => {
    // Mid-sentence in the Tell Clippy box: not now, and a fresh idle period once they're done.
    if (tellActive.current) lastActivity.current = Date.now();
    else setMode('mini');
  });

  const dismissQuip = useCallback(() => setQuip(undefined), []);

  const clippy = (
    <TrackingClippy
      shell={shell}
      mood={mood.mood}
      big={mood.big}
      seq={mood.seq}
      mini={mode === 'mini'}
      title="Professor Clippy: drag me, or click me"
      {...clippyDrag}
    />
  );

  const view =
    mode === 'mini' ? (
      <MiniView clippy={clippy} unread={unread} urgent={stack.messages.some((m) => m.urgent)} onBadgeClick={open} />
    ) : (
      <ExpandedView
        clippy={clippy}
        bubble={quip && <SpeechBubble text={quip} onDismiss={dismissQuip} />}
        note={
          <StickyNote
            tab={tab}
            onTab={setTab}
            unread={unread}
            onCollapse={() => setMode('mini')}
            drag={noteDrag}
            wiggleKey={wiggle}
            tabs={!firstRun}
          >
            {firstRun ? (
              <FirstRunWizard api={api} state={settingsState} />
            ) : (
              <>
                {tab === 'notes' && (
                  <NotesTab
                    stack={stack}
                    footer={
                      <TellBox
                        chat={chat}
                        shell={shell}
                        wantFocus={wantTellFocus}
                        onFocused={tellFocused}
                        onActive={setTellActive}
                        onCollapse={() => setMode('mini')}
                      />
                    }
                  />
                )}
                {tab === 'chat' && <ChatTab chat={chat} />}
                {tab === 'history' && <HistoryTab api={api} />}
                {tab === 'settings' && <SettingsTab api={api} state={settingsState} />}
              </>
            )}
          </StickyNote>
        }
      />
    );

  return runtime.browser ? <BrowserFrame mode={mode}>{view}</BrowserFrame> : view;
}
