import { DarkThemeId, THEMES, type ThemeId, type ThemeInfo } from '@clippy/shared/theme';
import { ToggleSetting, type SectionProps } from './controls';

/** The papers "Follow Windows dark mode" can switch to. */
const DARK_THEMES = THEMES.filter((t): t is ThemeInfo & { id: DarkThemeId } => DarkThemeId.safeParse(t.id).success);

/** A row of paper chips to pick a theme from; the picked one is ringed. */
export function ThemeSwatches<T extends ThemeId>({
  themes,
  value,
  label,
  onPick,
}: {
  themes: readonly (ThemeInfo & { id: T })[];
  value: T;
  /** Names the group for screen readers. */
  label: string;
  onPick(id: T): void;
}) {
  return (
    <div className="theme-swatches" role="radiogroup" aria-label={label}>
      {themes.map((t) => (
        <button
          key={t.id}
          type="button"
          role="radio"
          aria-checked={t.id === value}
          className="theme-swatch"
          title={t.label}
          aria-label={t.label}
          onClick={() => onPick(t.id)}
        >
          <span className="theme-swatch-chip" style={{ background: t.swatch }} />
        </button>
      ))}
    </div>
  );
}

const labelOf = (id: ThemeId) => THEMES.find((t) => t.id === id)?.label ?? id;

/** Settings → Look: the note's paper, following Windows dark mode (and with which dark paper), tips. */
export function LookSection({ settings, update }: SectionProps) {
  return (
    <>
      <div className="setting setting--stacked">
        <span className="setting-text">
          <span className="setting-label">Paper</span>
          <span className="setting-hint">Pick a paper; it changes at once. Now: {labelOf(settings.theme)}.</span>
        </span>
        <ThemeSwatches themes={THEMES} value={settings.theme} label="Paper" onPick={(theme) => void update({ theme })} />
      </div>
      <ToggleSetting name="followSystemDark" settings={settings} update={update} />
      {settings.followSystemDark && (
        <div className="setting setting--stacked">
          <span className="setting-text">
            <span className="setting-label">Dark paper</span>
            <span className="setting-hint">Used while Windows is dark. Now: {labelOf(settings.darkTheme)}.</span>
          </span>
          <ThemeSwatches
            themes={DARK_THEMES}
            value={settings.darkTheme}
            label="Dark paper"
            onPick={(darkTheme) => void update({ darkTheme })}
          />
        </div>
      )}
      <ToggleSetting name="showTips" settings={settings} update={update} />
    </>
  );
}
