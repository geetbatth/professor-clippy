import { useState } from 'react';
import type { ClaudeWiringReport, ClippyWindowApi } from '@clippy/shared/ipc';
import './ConnectClaude.css';

type Phase =
  | { at: 'idle' }
  | { at: 'previewing' }
  | { at: 'previewed'; report: ClaudeWiringReport }
  | { at: 'installing'; report: ClaudeWiringReport }
  | { at: 'installed'; report: ClaudeWiringReport }
  | { at: 'failed'; report: ClaudeWiringReport };

const failure = (err: unknown): ClaudeWiringReport => ({
  ok: false,
  log: [],
  error: err instanceof Error ? err.message : String(err),
  warnings: [],
});

/**
 * "Connect Claude Code": first shows exactly what would change (a dry run of the wiring),
 * and installs only when the user confirms that.
 */
export function ConnectClaude({ api, onInstalled }: { api: ClippyWindowApi; onInstalled?: () => void }) {
  const [phase, setPhase] = useState<Phase>({ at: 'idle' });

  const preview = async () => {
    setPhase({ at: 'previewing' });
    const report = await api.connectClaude('preview').catch(failure);
    setPhase(report.ok ? { at: 'previewed', report } : { at: 'failed', report });
  };
  const install = async (previewed: ClaudeWiringReport) => {
    setPhase({ at: 'installing', report: previewed });
    const report = await api.connectClaude('install').catch(failure);
    setPhase(report.ok ? { at: 'installed', report } : { at: 'failed', report });
    if (report.ok) onInstalled?.();
  };

  const report = 'report' in phase ? phase.report : undefined;
  return (
    <div className="connect-claude">
      {report && report.log.length > 0 && (
        <pre className="wiring-log" aria-label={phase.at === 'installed' ? 'What was done' : 'What will change'}>
          {report.log.join('\n')}
        </pre>
      )}
      {report?.warnings.map((w) => (
        <p key={w} className="wiring-warning">
          ⚠ {w}
        </p>
      ))}
      {phase.at === 'failed' && <p className="card-error">{phase.report.error}</p>}
      {phase.at === 'installed' && <p className="wiring-ok">Connected. New Claude Code sessions can now leave me notes.</p>}

      <div className="setting-actions">
        {(phase.at === 'idle' || phase.at === 'previewing' || phase.at === 'failed') && (
          <button className="btn btn-done" disabled={phase.at === 'previewing'} onClick={() => void preview()}>
            {phase.at === 'previewing' ? 'Checking…' : phase.at === 'failed' ? 'Try again' : 'Connect Claude Code…'}
          </button>
        )}
        {(phase.at === 'previewed' || phase.at === 'installing') && (
          <>
            <button className="btn btn-done" disabled={phase.at === 'installing'} onClick={() => void install(phase.report)}>
              {phase.at === 'installing' ? 'Installing…' : 'Looks good, install'}
            </button>
            <button className="btn btn-ghost" disabled={phase.at === 'installing'} onClick={() => setPhase({ at: 'idle' })}>
              Cancel
            </button>
          </>
        )}
      </div>
    </div>
  );
}
