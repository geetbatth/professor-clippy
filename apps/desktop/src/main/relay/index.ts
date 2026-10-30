/**
 * Starts, restarts and stops the relay as the Worker settings change. With no `workerUrl`
 * or no `workerSecret` the relay is off and nothing else touches the network (apart from
 * withdrawing the reminders from the Worker that was just disconnected).
 */
import type { Settings } from '@clippy/shared';
import { normalizeWorkerUrl, Relay, WITHDRAW_TIMEOUT_MS, type RelayDeps } from './relay';
import { RelayClient, type RelayTransport } from './relayClient';

export { Relay, formatForWhatsApp, WITHDRAW_TIMEOUT_MS } from './relay';

export { RelayClient, RelayHttpError } from './relayClient';

export interface RelayConfig {
  workerUrl: string;
  workerSecret: string;
}

/** The relay settings, or undefined when the relay is not configured. */
export function relayConfig(settings: Settings): RelayConfig | undefined {
  const { workerUrl, workerSecret } = settings;
  return workerUrl && workerSecret ? { workerUrl, workerSecret } : undefined;
}

export interface RelayManagerOptions extends Omit<RelayDeps, 'transport'> {
  makeTransport?: (config: RelayConfig) => RelayTransport;
  /** Time box for withdrawing reminders from a Worker being left (default {@link WITHDRAW_TIMEOUT_MS}). */
  withdrawTimeoutMs?: number;
}

export class RelayManager {
  readonly #o: RelayManagerOptions;
  #relay: Relay | undefined;
  #key: string | undefined;
  #url: string | undefined;
  /** Withdrawals in progress, by normalized Worker URL. */
  readonly #withdrawals = new Map<string, { ctl: AbortController; done: Promise<void> }>();

  constructor(options: RelayManagerOptions) {
    this.#o = options;
  }

  /** True while a relay is running (i.e. it is configured). */
  get active(): boolean {
    return this.#relay !== undefined;
  }

  /**
   * (Re)start for these settings; does nothing if the Worker settings didn't change.
   *
   * Every start (the app starting with WhatsApp configured, or a changed Worker URL or
   * secret) runs the relay's gap-fill: reminders this Worker hasn't acknowledged with a 2xx
   * are PUT, the rest are left alone. A socket reconnect never re-syncs anything.
   *
   * Leaving a Worker (WhatsApp disconnected, or a different Worker URL) first withdraws the
   * reminders it holds, in the background: see {@link Relay.withdrawReminders}. Otherwise
   * its alarms would go on sending them to WhatsApp. A new secret for the same Worker is not
   * leaving it. Coming back to a Worker whose withdrawal is still running waits for it to end
   * before the gap-fill, so the two don't fight over the same reminders.
   */
  apply(settings: Settings): void {
    const config = relayConfig(settings);
    const key = config && JSON.stringify(config);
    if (key === this.#key) return;
    const old = this.#relay;
    const oldUrl = this.#url;
    this.#relay = undefined;
    this.#key = key;
    this.#url = config?.workerUrl;
    if (old) {
      old.stop(); // no new Worker calls from it; its transport still answers REST
      if (oldUrl !== undefined && (!config || normalizeWorkerUrl(config.workerUrl) !== normalizeWorkerUrl(oldUrl))) {
        this.#withdraw(old, oldUrl);
      }
    }
    if (!config) return;
    const makeTransport =
      this.#o.makeTransport ??
      ((c: RelayConfig) => new RelayClient({ ...c, ...(this.#o.log && { log: this.#o.log }) }));
    const { makeTransport: _unused, withdrawTimeoutMs: _unused2, ...deps } = this.#o;
    const relay = new Relay({ ...deps, workerUrl: config.workerUrl, transport: makeTransport(config) });
    this.#relay = relay;
    relay.start();
    const pending = this.#withdrawals.get(normalizeWorkerUrl(config.workerUrl));
    if (!pending) relay.syncExistingReminders();
    else void pending.done.then(() => relay.syncExistingReminders()); // no-op if stopped by then
  }

  /** Resolves when every withdrawal in progress has ended (tests). */
  async withdrawn(): Promise<void> {
    await Promise.all([...this.#withdrawals.values()].map((w) => w.done));
  }

  #withdraw(relay: Relay, workerUrl: string): void {
    const url = normalizeWorkerUrl(workerUrl);
    this.#withdrawals.get(url)?.ctl.abort(); // can't happen in practice (we left this URL once)
    const ctl = new AbortController();
    const entry = {
      ctl,
      done: relay
        .withdrawReminders({ timeoutMs: this.#o.withdrawTimeoutMs ?? WITHDRAW_TIMEOUT_MS, signal: ctl.signal })
        .then(
          (held) => {
            if (held.length) this.#log(`relay: ${held.length} reminder(s) are still on ${url}; they go when you reconnect to it`);
          },
          (err) => this.#log('relay: withdrawing reminders failed', err),
        )
        .finally(() => {
          if (this.#withdrawals.get(url) === entry) this.#withdrawals.delete(url);
        }),
    };
    this.#withdrawals.set(url, entry);
  }

  #log(message: string, err?: unknown): void {
    if (this.#o.log) this.#o.log(message, err);
    else if (err === undefined) console.info(`[clippy] ${message}`);
    else console.warn(`[clippy] ${message}:`, err instanceof Error ? err.message : err);
  }

  /** Reconnect the running relay's socket now (no-op when the relay is off). */
  reconnect(): void {
    this.#relay?.reconnect();
  }

  /** Stop the relay and abandon any withdrawal in progress (the app is quitting: never wait). */
  stop(): void {
    this.#relay?.stop();
    this.#relay = undefined;
    this.#key = undefined;
    this.#url = undefined;
    for (const w of this.#withdrawals.values()) w.ctl.abort();
  }
}
