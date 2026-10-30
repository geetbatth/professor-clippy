import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClippyWindowApi, TelegramStatus } from '@clippy/shared/ipc';
import type { SettingsPatch } from '@clippy/shared/settings';
import { parseChatId, telegramBadge, telegramStatusLine } from './telegram';
import './TelegramSetup.css';

/** How often the status is re-read while the panel is open (pairing happens on the phone). */
const POLL_MS = 2000;

const message = (err: unknown) => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));

/** The Telegram badge for a fieldset legend. */
export function TelegramBadge({ status }: { status: TelegramStatus | undefined }) {
  const badge = status ? telegramBadge(status) : 'off';
  return <span className={badge === 'connected' ? 'relay-on' : badge === 'error' ? 'tg-badge-error' : 'relay-off'}>{badge}</span>;
}

/**
 * Telegram: the bot token (password field, "saved" once stored), pairing (a code to send as
 * `/start CODE`, or a chat id typed in), the paired chat with Unpair and Send test, and a
 * status line. Used by Settings and the first-run wizard.
 */
export function TelegramSetup({
  api,
  update,
  onStatus,
}: {
  api: ClippyWindowApi;
  /** Saves a settings patch (the chat id typed in directly). */
  update: (patch: SettingsPatch) => Promise<boolean>;
  onStatus?: (status: TelegramStatus) => void;
}) {
  const [status, setStatus] = useState<TelegramStatus>();
  const [token, setToken] = useState('');
  const [chatId, setChatId] = useState('');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  const [busy, setBusy] = useState(false);

  // A ref, so a parent passing a new callback each render doesn't restart the polling.
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const show = useCallback((s: TelegramStatus) => {
    setStatus(s);
    onStatusRef.current?.(s);
  }, []);
  const refresh = useCallback(() => {
    void api.telegramStatus().then(show, () => {});
  }, [api, show]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    setNote(undefined);
    try {
      await fn();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const saveToken = () =>
    run(async () => {
      if (!token.trim()) {
        setError('Paste the token @BotFather gave you.');
        return;
      }
      show(await api.setTelegramToken(token.trim()));
      setToken('');
    });
  const removeToken = () => run(async () => show(await api.setTelegramToken(null)));
  const unpair = () => run(async () => show(await api.telegramUnpair()));
  const sendTest = () =>
    run(async () => {
      const result = await api.telegramSendTest();
      if (result.ok) setNote('Sent. Check Telegram.');
      else setError(result.error ?? 'The test message did not go through.');
    });
  const saveChatId = () =>
    run(async () => {
      const id = parseChatId(chatId);
      if (id === undefined) {
        setError('Your chat id is a positive number, like 123456789 (group and channel ids can’t be paired).');
        return;
      }
      if (await update({ telegramChatId: id, telegramChatName: null })) setChatId('');
      refresh();
    });

  const paired = status?.chatId !== undefined;
  return (
    <div className="tg-setup">
      <input
        className="field-input"
        type="password"
        autoComplete="off"
        placeholder={status?.tokenSaved ? '•••••••• (saved)' : 'Bot token from @BotFather'}
        value={token}
        aria-label="Telegram bot token"
        onChange={(e) => {
          setToken(e.target.value);
          setError(undefined);
        }}
        onKeyDown={(e) => e.key === 'Enter' && void saveToken()}
      />
      <div className="setting-actions">
        <button className="btn btn-done" disabled={busy || !token.trim()} onClick={() => void saveToken()}>
          Save token
        </button>
        {status?.tokenSaved && (
          <button className="btn btn-ghost" disabled={busy} title="Stops Telegram and forgets the token." onClick={() => void removeToken()}>
            Remove
          </button>
        )}
      </div>

      {status?.tokenSaved && !paired && (
        <div className="tg-pairing">
          {status.pairingCode && (
            <p className="tg-code-line">
              Send <code className="tg-code">/start {status.pairingCode}</code> to your bot
              {status.botUsername ? ` (@${status.botUsername})` : ''}.
            </p>
          )}
          <span className="setting-hint">Or set your chat id directly:</span>
          <div className="setting-actions">
            <input
              className="field-input tg-chat-id"
              inputMode="numeric"
              placeholder="Chat id"
              value={chatId}
              aria-label="Telegram chat id"
              onChange={(e) => setChatId(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void saveChatId()}
            />
            <button className="btn btn-ghost" disabled={busy || !chatId.trim()} onClick={() => void saveChatId()}>
              Set
            </button>
          </div>
        </div>
      )}

      {paired && (
        <div className="tg-paired">
          <span>
            Paired with <b>{status?.chatName ?? `chat ${status?.chatId}`}</b>
          </span>
          <div className="setting-actions">
            <button className="btn btn-done" disabled={busy} onClick={() => void sendTest()}>
              Send test
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => void unpair()}>
              Unpair
            </button>
          </div>
        </div>
      )}

      {status && <p className={`tg-status tg-status--${status.state}`}>{telegramStatusLine(status)}</p>}
      {note && <p className="tg-note">{note}</p>}
      {error && <p className="card-error">{error}</p>}
    </div>
  );
}
