import { useEffect, useRef, type ReactNode } from 'react';
import type { DragHandle } from '../hooks/useWindowDrag';
import './StickyNote.css';

export type Tab = 'notes' | 'chat' | 'history' | 'settings';

const TABS: readonly { id: Tab; label: string }[] = [
  { id: 'notes', label: 'Notes' },
  { id: 'chat', label: 'Chat' },
  { id: 'history', label: 'History' },
  { id: 'settings', label: 'Settings' },
];

export interface StickyNoteProps {
  tab: Tab;
  onTab(tab: Tab): void;
  unread: number;
  onCollapse(): void;
  /** The header is the drag handle in expanded mode. */
  drag: DragHandle;
  /** Plays the "new message" wiggle when this changes. */
  wiggleKey: number;
  /** Show the tab bar (hidden during the first-run wizard). Default true. */
  tabs?: boolean;
  children: ReactNode;
}

/** The yellow sticky note Clippy stands on: a header to drag by, tabs, and the tab's content. */
export function StickyNote({ tab, onTab, unread, onCollapse, drag, wiggleKey, tabs = true, children }: StickyNoteProps) {
  const ref = useRef<HTMLElement>(null);
  // Restart the wiggle without remounting (which would lose typed text).
  useEffect(() => {
    const el = ref.current;
    if (!el || wiggleKey === 0) return;
    el.classList.remove('note--wiggle');
    void el.offsetWidth;
    el.classList.add('note--wiggle');
  }, [wiggleKey]);
  return (
    <section ref={ref} className="note" data-solid="" onAnimationEnd={(e) => e.target === ref.current && ref.current?.classList.remove('note--wiggle')}>
      <header className="note-header" {...drag}>
        <h1 className="note-title">Professor Clippy</h1>
        <button
          className="note-collapse"
          title="Tuck Clippy away"
          aria-label="Collapse"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={onCollapse}
        >
          –
        </button>
      </header>
      {tabs && (
        <nav className="note-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`note-tab${tab === t.id ? ' note-tab--on' : ''}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
              {t.id === 'notes' && unread > 0 && <span className="note-tab-count">{unread}</span>}
            </button>
          ))}
        </nav>
      )}
      <div className="note-body">{children}</div>
    </section>
  );
}
