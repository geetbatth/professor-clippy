/**
 * Starts, restarts and stops the relay as the Worker settings change. With no `workerUrl`
 * or no `workerSecret` the relay is off and nothing touches the network.
 */
import type { Settings } from '@clippy/shared';
import { normalizeWorkerUrl, Relay, type RelayDeps } from './relay';
import { RelayClient, type RelayTransport } from './relayClient';

export { Relay, formatForWhatsApp } from './relay';

/** kv key: the Worker URL the relay was last configured with (absent while it is off). */
export const RELAY_WORKER_KV_KEY = 'relayWorkerUrl';
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
   * When the relay goes from off to on with a Worker URL it wasn't last configured with
   * (WhatsApp set up for the first time, or moved to another Worker), the reminders that
   * Worker has never seen are synced once. A restart of the app with the same Worker, a new
   * secret, or a reconnect never re-syncs.
   */
  apply(settings: Settings): void {
    const config = relayConfig(settings);
    const key = config && JSON.stringify(config);
    if (key === this.#key) return;
    this.stop();
    this.#key = key;
    const { store } = this.#o;
    if (!config) {
      store.deleteKv(RELAY_WORKER_KV_KEY);
      return;
    }
    const makeTransport =
      this.#o.makeTransport ??
      ((c: RelayConfig) => new RelayClient({ ...c, ...(this.#o.log && { log: this.#o.log }) }));
    const { makeTransport: _unused, ...deps } = this.#o;
    this.#relay = new Relay({ ...deps, workerUrl: config.workerUrl, transport: makeTransport(config) });
    this.#relay.start();
    const worker = normalizeWorkerUrl(config.workerUrl);
    if (store.getKv(RELAY_WORKER_KV_KEY) !== worker) {
      this.#relay.syncExistingReminders();
      store.setKv(RELAY_WORKER_KV_KEY, worker);
    }
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
