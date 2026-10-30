import { useEffect, useState } from 'react';
import { ASK_WAIT_MAX_MINUTES, ASK_WAIT_MIN_MINUTES, askWaitMinutes, parseAskWait } from '../askWait';
import { ConnectClaude } from '../ConnectClaude';
import { SettingRow, ToggleSetting, type SectionProps } from './controls';

/** Settings → Claude Code: the hook, how long questions wait, phone approvals, and the wiring. */
export function ClaudeSection({ api, settings, update }: SectionProps) {
  const [askWait, setAskWait] = useState(() => askWaitMinutes(settings.askTimeoutDefaultS));
  const [askWaitError, setAskWaitError] = useState(false);

  useEffect(() => {
    setAskWait(askWaitMinutes(settings.askTimeoutDefaultS));
  }, [settings.askTimeoutDefaultS]);

  /** Save the ask wait on blur / Enter, only if it's valid and changed. */
  const commitAskWait = () => {
    const seconds = parseAskWait(askWait);
    if (seconds === undefined) {
      setAskWaitError(true);
      return;
    }
    setAskWaitError(false);
    setAskWait(askWaitMinutes(seconds));
    if (seconds !== settings.askTimeoutDefaultS) void update({ askTimeoutDefaultS: seconds });
  };

  return (
    <>
      <ToggleSetting name="hookEnabled" settings={settings} update={update} />
      <SettingRow label="Wait for answers" hint={`How long an agent's question waits before it gets "no answer yet".`}>
        <span className="setting-number">
          <input
            type="text"
            inputMode="numeric"
            className={`field-input${askWaitError ? ' field-input--bad' : ''}`}
            value={askWait}
            aria-invalid={askWaitError}
            onChange={(e) => {
              setAskWait(e.target.value);
              setAskWaitError(false);
            }}
            onBlur={commitAskWait}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitAskWait();
              if (e.key === 'Escape') setAskWait(askWaitMinutes(settings.askTimeoutDefaultS));
            }}
          />
          min
        </span>
      </SettingRow>
      {askWaitError && (
        <p className="card-error">
          Whole minutes between {ASK_WAIT_MIN_MINUTES} and {ASK_WAIT_MAX_MINUTES}, please.
        </p>
      )}
      <ToggleSetting name="phoneApprovals" settings={settings} update={update} disabled={!settings.hookEnabled} />
      <div className="setting-group">
        <span className="setting-hint">Register my MCP server, hook and CLAUDE.md hint (shows the changes first).</span>
        <ConnectClaude api={api} />
      </div>
    </>
  );
}
