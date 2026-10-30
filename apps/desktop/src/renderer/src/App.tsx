import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PAGE_USER_AUTHOR, type Message } from '@clippy/shared/schemas';
import type { Settings } from '@clippy/shared/settings';
import type { WindowMode } from '../../main/window/windowApi';
import { TrackingClippy } from './clippy/TrackingClippy';
import { useClippyMood, type ClippyMood } from './clippy/useClippyMood';
import { useAdvice } from './hooks/useAdvice';
import { useAutoCollapse } from './hooks/useAutoCollapse';
import { useChat } from './hooks/useChat';
import { useClickThrough } from './hooks/useClickThrough';
import { useOnboarding } from './hooks/useOnboarding';
import { usePages } from './hooks/usePages';
import { useSettings } from './hooks/useSettings';
import { useTheme } from './hooks/useTheme';
import { useTips } from './hooks/useTips';
import { useUnread } from './hooks/useUnread';
import { useWindowDrag } from './hooks/useWindowDrag';
import { alertLevel, loudCount } from './note/alertLevel';
import { ChatTab } from './note/ChatTab';
import { FirstRunWizard } from './note/FirstRunWizard';
import { NotesTab } from './note/NotesTab';
import { PadTab } from './note/PadTab';
import { SettingsTab } from './note/SettingsTab';
import { SECTIONS } from './note/settings/SettingsMenu';
import type { SettingsSection } from './note/settings/summaries';
import { StickyNote, type Tab } from './note/StickyNote';
import { TellBox } from './note/TellBox';
import { TIP_SHOW_MS } from './note/welcome/tips';
import { pickQuip, quipForMessage } from './quips/pickQuip';
import type { Runtime } from './runtime';
import { createSoundBoard } from './sound/sounds';
import { BrowserFrame } from './views/BrowserFrame';
import { ExpandedView } from './views/ExpandedView';
import { MiniView } from './views/MiniView';
import { SpeechBubble } from './views/SpeechBubble';

/** The open note tucks itself away after this long with nothing to show and nobody about. */
const AUTO_COLLAPSE_MS = 2 * 60_000;
const TABS: readonly Tab[] = ['notes', 'pad', 'chat', 'settings'];

export function App({ runtime }: { runtime: Runtime }) {
  const { api, shell } = runtime;
  // Dev/screenshot hooks: ?mode=expanded&tab=chat, ?tab=settings&section=look (tab=history is Settings → History)
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const [mode, setModeState] = useState<WindowMode>(params.get('mode') === 'expanded' ? 'expanded' : 'mini');
  const [tab, setTab] = useState<Tab>(params.get('tab') === 'history' ? 'settings' : (TABS.find((t) => t === params.get('tab')) ?? 'notes'));
  /** The Settings section open (undefined: its menu). */
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(
    params.get('tab') === 'history' ? 'history' : SECTIONS.find((s) => s.id === params.get('section'))?.id,
  );
  const [quip, setQuip] = useState<string>();
  /** A one-time tip in the bubble (a quip, which is about a new message, always wins). */
  const [tip, setTip] = useState<string>();
  const [wiggle, setWiggle] = useState(0);
  /** The hotkey asked for the Tell Clippy box; cleared once it has taken focus. */
  const [wantTellFocus, setWantTellFocus] = useState(false);
  /** The Tell Clippy box has focus or text: the note must not tuck itself away. */
  const tellActive = useRef(false);
  /** A Pad page has focus (or an unsettled conflict): the same rule as the Tell box. */
  const padActive = useRef(false);

  const settingsState = useSettings(api);
  const { settings } = settingsState;
  const { refresh: refreshSettings } = settingsState;
  // Opening Settings shows the current values (the tray can change sounds behind our back).
  useEffect(() => {
    if (tab === 'settings') refreshSettings();
  }, [tab, refreshSettings]);
  useTheme(api, settings, refreshSettings);
  const soundOn = useRef(true);
  soundOn.current = settings?.soundEnabled ?? true;
  const popUpFor = useRef<Settings['popUpFor']>('important');
  popUpFor.current = settings?.popUpFor ?? 'important';
  const sounds = useMemo(() => createSoundBoard(() => soundOn.current), []);
  const chat = useChat(api);
  const pad = usePages(api);
  const onboarding = useOnboarding(api);

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
      if (m === 'mini') {
        setQuip(undefined);
        setTip(undefined);
      }
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
  /** Show Settings, at `section` or (without one) its menu. Anything in the note can deep-link here. */
  const openSettings = useCallback((section?: SettingsSection) => {
    setSettingsSection(section);
    setTab('settings');
  }, []);
  // The Settings tab itself always opens on the menu.
  const pickTab = useCallback((t: Tab) => (t === 'settings' ? openSettings() : setTab(t)), [openSettings]);
  const showHistory = useCallback(() => openSettings('history'), [openSettings]);
  const tellFocused = useCallback(() => setWantTellFocus(false), []);
  const setTellActive = useCallback((active: boolean) => {
    tellActive.current = active;
  }, []);
  const setPadActive = useCallback((active: boolean) => {
    padActive.current = active;
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
    // Mid-sentence in the Tell Clippy box or a page: not now, and a fresh idle period once they're done.
    if (tellActive.current || padActive.current) lastActivity.current = Date.now();
    else setMode('mini');
  });

  const dismissQuip = useCallback(() => setQuip(undefined), []);
  const dismissTip = useCallback(() => setTip(undefined), []);
  // A quip (a new message, advice) takes the bubble from a tip for good.
  useEffect(() => {
    if (quip !== undefined) setTip(undefined);
  }, [quip]);

  // One-time tips: only into a free bubble on the open note, never over a quip or the welcome.
  const quipRef = useRef(quip);
  quipRef.current = quip;
  const firstRunRef = useRef(firstRun);
  firstRunRef.current = firstRun;
  const showTip = useTips({
    api,
    onboarding,
    showTips: settings?.showTips ?? false,
    canShow: () => modeRef.current === 'expanded' && quipRef.current === undefined && !firstRunRef.current,
    show: setTip,
  });
  // The user made a page (not Clippy or an agent): the pin-out tip may be due.
  const userPages = pad.loaded ? [...pad.pages, ...pad.archived].filter((p) => p.author === PAGE_USER_AUTHOR).length : undefined;
  const lastUserPages = useRef<number>(undefined);
  useEffect(() => {
    if (userPages === undefined) return;
    const before = lastUserPages.current;
    lastUserPages.current = userPages;
    if (before !== undefined && userPages > before) showTip({ kind: 'page-created', userPages });
  }, [userPages, showTip]);
  const hotkeyTicked = useRef(false);
  hotkeyTicked.current = onboarding?.done.includes('hotkey') ?? false;
  const told = useCallback(
    (text: string) => {
      if (!hotkeyTicked.current) api.markOnboarding('hotkey').catch(() => {});
      showTip({ kind: 'tell', text });
    },
    [api, showTip],
  );
  const finishWelcome = useCallback(() => setTab('pad'), []);

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
        bubble={
          quip !== undefined ? (
            <SpeechBubble key="quip" text={quip} onDismiss={dismissQuip} />
          ) : (
            tip !== undefined && <SpeechBubble key="tip" text={tip} ms={TIP_SHOW_MS} onDismiss={dismissTip} />
          )
        }
        note={
          <StickyNote
            tab={tab}
            onTab={pickTab}
            unread={unread}
            padNew={pad.unseen}
            onCollapse={() => setMode('mini')}
            drag={noteDrag}
            wiggleKey={wiggle}
            tabs={!firstRun}
          >
            {firstRun ? (
              <FirstRunWizard api={api} state={settingsState} onFinish={finishWelcome} />
            ) : (
              <>
                {tab === 'notes' && (
                  <NotesTab
                    stack={stack}
                    onHistory={showHistory}
                    footer={
                      <TellBox
                        chat={chat}
                        shell={shell}
                        wantFocus={wantTellFocus}
                        onFocused={tellFocused}
                        onActive={setTellActive}
                        onCollapse={() => setMode('mini')}
                        onSend={told}
                      />
                    }
                  />
                )}
                {tab === 'pad' && (
                  <PadTab api={api} pad={pad} onActive={setPadActive} onboarding={onboarding} settings={settings} onSettings={openSettings} />
                )}
                {tab === 'chat' && <ChatTab chat={chat} />}
                {tab === 'settings' && <SettingsTab api={api} state={settingsState} section={settingsSection} onSection={openSettings} />}
              </>
            )}
          </StickyNote>
        }
      />
    );

  return runtime.browser ? <BrowserFrame mode={mode}>{view}</BrowserFrame> : view;
}
