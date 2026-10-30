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

  /** (Re)start for these settings; does nothing if the Worker settings didn't change. */
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
    this.#relay = new Relay({ ...deps, transport: makeTransport(config) });
    this.#relay.start();
  }

  stop(): void {
    this.#relay?.stop();
    this.#relay = undefined;
    this.#key = undefined;
  }
}
