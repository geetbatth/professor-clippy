/**
 * Starts, restarts and stops the relay as the Worker settings change. With no `workerUrl`
 * or no `workerSecret` the relay is off and nothing touches the network.
 */
import type { Settings } from '@clippy/shared';
import { Relay, type RelayDeps } from './relay';
import { RelayClient, type RelayTransport } from './relayClient';

export { Relay, formatForWhatsApp } from './relay';

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
}

export class RelayManager {
  readonly #o: RelayManagerOptions;
  #relay: Relay | undefined;
  #key: string | undefined;

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
   */
  apply(settings: Settings): void {
    const config = relayConfig(settings);
    const key = config && JSON.stringify(config);
    if (key === this.#key) return;
    this.stop();
    this.#key = key;
    if (!config) return;
    const makeTransport =
      this.#o.makeTransport ??
      ((c: RelayConfig) => new RelayClient({ ...c, ...(this.#o.log && { log: this.#o.log }) }));
    const { makeTransport: _unused, ...deps } = this.#o;
    this.#relay = new Relay({ ...deps, workerUrl: config.workerUrl, transport: makeTransport(config) });
    this.#relay.start();
    this.#relay.syncExistingReminders();
  }

  /** Reconnect the running relay's socket now (no-op when the relay is off). */
  reconnect(): void {
    this.#relay?.reconnect();
  }

  stop(): void {
    this.#relay?.stop();
    this.#relay = undefined;
    this.#key = undefined;
  }
}
