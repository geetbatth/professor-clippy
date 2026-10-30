import type { OnboardingState } from '@clippy/shared/schemas';
import type { Settings } from '@clippy/shared/settings';
import type { SettingsSection } from '../settings/summaries';
import { CHECKLIST, checklistProgress, howTo } from './tour';
import './GettingStarted.css';

export interface GettingStartedProps {
  state: OnboardingState;
  settings: Settings;
  onBack(): void;
  /** Open Settings where an item is set up ("Show me ›"). */
  onSettings(section: SettingsSection): void;
  /** Put the list away for good (until the welcome is run again). */
  onDismiss(): void;
}

/**
 * The Pad's Getting started page: the seven things worth trying once, on lined paper. Ticked ones
 * are struck through; each one still to do says how, with a way into Settings where it lives there.
 */
export function GettingStarted({ state, settings, onBack, onSettings, onDismiss }: GettingStartedProps) {
  const { done, total } = checklistProgress(state);
  return (
    <div className="pad pad--page">
      <button type="button" className="pad-back" onClick={onBack}>
        ‹ All pages
      </button>
      <div className="page-paper gs-paper">
        <h2 className="gs-title">Getting started 📎</h2>
        <ul className="gs-list">
          {CHECKLIST.map(({ item, label, section }) => {
            const ticked = state.done.includes(item);
            return (
              <li key={item} className={`gs-item${ticked ? ' gs-item--done' : ''}`}>
                <span className="gs-box" role="img" aria-label={ticked ? 'Done' : 'Not yet'}>
                  {ticked ? '☑' : '☐'}
                </span>
                <span className="gs-text">
                  <span className="gs-label">{label}</span>
                  {!ticked && (
                    <span className="gs-how">
                      {howTo(item, settings)}
                      {section && (
                        <>
                          {' '}
                          <button type="button" className="gs-show" onClick={() => onSettings(section)}>
                            Show me ›
                          </button>
                        </>
                      )}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="page-footer">
        <span className="page-status">
          {done} of {total} done
        </span>
        <span className="page-footer-gap" />
        <button type="button" className="btn btn-ghost page-keep" onClick={onDismiss}>
          Hide this list
        </button>
      </div>
    </div>
  );
}
