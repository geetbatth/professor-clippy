import { useState } from 'react';
import type { ClippyWindowApi, TelegramStatus } from '@clippy/shared/ipc';
import { THEMES } from '@clippy/shared/theme';
import type { SettingsState } from '../hooks/useSettings';
import { useNow } from '../hooks/useNow';
import { AskCard } from './AskCard';
import { ConnectClaude } from './ConnectClaude';
import { nextStep, relayBadge, WIZARD_STEPS, type WizardStep } from './firstRun';
import { ThemeSwatches } from './settings/LookSection';
import { RelayFields } from './settings/PhoneSection';
import { ToggleSetting } from './settings/controls';
import { TelegramSetup } from './TelegramSetup';
import { demoQuestion, tellLine } from './welcome/tour';
import './cards.css';
import './SettingsTab.css';
import './FirstRunWizard.css';

/**
 * First run, inside the note. It starts with what makes Clippy useful and lets every step be
 * skipped: Connect Claude Code ("Later"), how he looks (applied at once), the phone (Telegram
 * first, WhatsApp for the brave, "Not now"), then a practice question answered for real on a real
 * question card. Finishing sets `firstRunDone` and opens the Pad, where Getting started waits.
 */
export function FirstRunWizard({ api, state, onFinish }: { api: ClippyWindowApi; state: SettingsState; onFinish(): void }) {
  const { settings, update, error: saveError } = state;
  const [step, setStep] = useState<WizardStep>('claude');
  const [claudeConnected, setClaudeConnected] = useState(false);
  const [telegram, setTelegram] = useState<TelegramStatus>();
  const [phoneOpen, setPhoneOpen] = useState<'telegram' | 'relay'>();
  // The practice question lives only here: never stored, mirrored or sent anywhere.
  const [question, setQuestion] = useState(() => demoQuestion(Date.now()));
  const now = useNow(30_000);

  if (!settings) return <p className="settings-loading">Fetching my notes…</p>;

  const finish = async () => {
    if (await update({ firstRunDone: true })) onFinish();
  };
  const advance = () => {
    const next = nextStep(step);
    if (next) setStep(next);
    else void finish();
  };
  const at = WIZARD_STEPS.indexOf(step);
  const answered = question.answer !== undefined;
  const phoneReady = telegram?.chatId !== undefined || relayBadge(settings) === 'saved';

  return (
    <div className="wizard">
      <ol className="wizard-steps" aria-label="Setup steps">
        {WIZARD_STEPS.map((s, i) => (
          <li key={s} className={s === step ? 'on' : at > i ? 'done' : ''} aria-current={s === step ? 'step' : undefined}>
            {at > i ? '✓' : i + 1}
          </li>
        ))}
      </ol>

      {step === 'claude' && (
        <section>
          <h2 className="wizard-title">Welcome! I'm Professor Clippy.</h2>
          <p className="wizard-text">
            Your AI agents leave me notes, reminders and questions, and I make sure you see them. You can also keep your own
            notes on my Pad.
          </p>
          <p className="wizard-text">First, let me plug into Claude Code.</p>
          <p className="wizard-text wizard-small">
            I register my MCP server with Claude Code (so agents can leave notes, set reminders and ask you things), add a hook
            that tells me when an agent finishes or needs permission, and add a hint to your global CLAUDE.md. You see the exact
            changes first.
          </p>
          <ConnectClaude
            api={api}
            onInstalled={() => setClaudeConnected(true)}
            actions={
              <button className={`btn ${claudeConnected ? 'btn-done' : 'btn-ghost'}`} onClick={advance}>
                {claudeConnected ? 'Next' : 'Later'}
              </button>
            }
          />
        </section>
      )}

      {step === 'look' && (
        <section>
          <h2 className="wizard-title">How should I look?</h2>
          <ThemeSwatches themes={THEMES} value={settings.theme} label="Paper" onPick={(theme) => void update({ theme })} />
          <ToggleSetting name="followSystemDark" settings={settings} update={update} />
          <ToggleSetting name="soundEnabled" settings={settings} update={update} />
          <ToggleSetting name="unsolicitedAdvice" settings={settings} update={update} />
          <ToggleSetting name="autoStart" settings={settings} update={update} />
          {saveError && <p className="card-error">Couldn't save that: {saveError}</p>}
          <div className="setting-actions wizard-finish">
            <span className="wizard-text wizard-small wizard-aside">You can change these, and the rest, in Settings any time.</span>
            <button className="btn btn-done" onClick={advance}>
              Next
            </button>
          </div>
        </section>
      )}

      {step === 'phone' && (
        <section>
          <h2 className="wizard-title">Want me on your phone?</h2>
          <p className="wizard-text">
            When you're away from the PC, I'll send notes and questions to your phone, and you can reply from there.
          </p>
          {phoneOpen === 'telegram' ? (
            <>
              <p className="wizard-text wizard-small">Make a bot with @BotFather, paste its token here, then send it the pairing code.</p>
              <TelegramSetup api={api} update={update} onStatus={setTelegram} />
            </>
          ) : (
            <div className="setting-actions">
              <button className="btn btn-done" onClick={() => setPhoneOpen('telegram')}>
                Set up Telegram
              </button>
            </div>
          )}
          <button
            type="button"
            className="wizard-link"
            aria-expanded={phoneOpen === 'relay'}
            onClick={() => setPhoneOpen((o) => (o === 'relay' ? undefined : 'relay'))}
          >
            WhatsApp (advanced) {phoneOpen === 'relay' ? '⌄' : '›'}
          </button>
          {phoneOpen === 'relay' && (
            <>
              <p className="wizard-text wizard-small">
                Through Meta's WhatsApp Cloud API and a Cloudflare Worker you deploy yourself (see docs/USER-TODO.md). Paste its
                URL and the <code>PC_SECRET</code> you gave it.
              </p>
              <RelayFields settings={settings} update={update} />
            </>
          )}
          {saveError && <p className="card-error">Couldn't save that: {saveError}</p>}
          <div className="setting-actions wizard-finish">
            <button className={`btn ${phoneReady ? 'btn-done' : 'btn-ghost'}`} onClick={advance}>
              {phoneReady ? 'Next' : 'Not now'}
            </button>
          </div>
        </section>
      )}

      {step === 'tour' && (
        <section>
          <h2 className="wizard-title">Try it</h2>
          <p className="wizard-bubble">This is what an agent's question looks like. Tap an answer!</p>
          <div className={`wizard-demo${answered ? ' wizard-demo--answered' : ''}`}>
            <AskCard
              m={question}
              now={now}
              onAnswer={async (answer) => {
                setQuestion((q) => ({ ...q, answer, answeredVia: 'desk', state: 'done' }));
                api.markOnboarding('answer').catch(() => {});
              }}
              onDone={() => {}}
              onSnooze={() => {}}
            />
          </div>
          {answered && (
            <>
              <p className="wizard-ok">✓ Answered. Agents get your reply the same way.</p>
              <p className="wizard-text">{tellLine(settings.tellHotkey)}</p>
            </>
          )}
          {saveError && <p className="card-error">Couldn't save that: {saveError}</p>}
          <div className="setting-actions wizard-finish">
            <button className={`btn ${answered ? 'btn-done' : 'btn-ghost'}`} onClick={() => void finish()}>
              Finish
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
