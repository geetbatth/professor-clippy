import { useState } from 'react';
import { SNOOZE_CHOICES, snoozeUntil } from './snooze';

/** "Snooze" with a little pop-up of 10 min / 1 hour / tomorrow 9:00. */
export function SnoozeMenu({ onSnooze }: { onSnooze: (until: number) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="snooze">
      <button className="btn btn-ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Snooze ▾
      </button>
      {open && (
        <span className="snooze-menu" role="menu">
          {SNOOZE_CHOICES.map(({ choice, label }) => (
            <button
              key={choice}
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSnooze(snoozeUntil(choice, Date.now()));
              }}
            >
              {label}
            </button>
          ))}
        </span>
      )}
    </span>
  );
}
