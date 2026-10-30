/**
 * Wires the core service together: store → bus → scheduler + asks → local API.
 * The Electron main process calls {@link startCore} once at startup.
 */
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appDataDir, dbPath, portPath, tokenPath } from '@clippy/shared';
import { startApi, type ApiServer } from './api';
import { Asks } from './asks';
import { Bus } from './bus';
import { systemClock, type Clock } from './clock';
import { Scheduler } from './scheduler';
import { Store } from './store';
import { loadOrCreateToken } from './token';

export interface StartCoreOptions {
  /** Data directory for token/port/db files. Default: `appDataDir()` (CLIPPY_HOME or %APPDATA%/professor-clippy). */
  dataDir?: string;
  /** Time source; default the system clock. */
  clock?: Clock;
  /** Version reported by `GET /health` (pass `app.getVersion()`). Default `'dev'`. */
  version?: string;
  /**
   * Event bus to use. Pass one with listeners already attached to also receive
   * the events of the startup catch-up (missed reminders, expired snoozes),
   * which run inside `startCore`. Default: a new Bus.
   */
  bus?: Bus;
}

export interface Core {
  store: Store;
  bus: Bus;
  scheduler: Scheduler;
  asks: Asks;
  api: ApiServer;
  /** Port the local API listens on (also written to the port file). */
  port: number;
  /** Bearer token for the local API (also in the token file). */
  token: string;
  /** Stop the API, scheduler and pending long-polls, then close the database. Idempotent. */
  stop(): Promise<void>;
}

export async function startCore(options: StartCoreOptions = {}): Promise<Core> {
  const dir = options.dataDir ?? appDataDir();
  // Same file names as @clippy/shared paths, relocated into `dir`.
  const file = (sharedPath: () => string): string => join(dir, basename(sharedPath()));
  await mkdir(dir, { recursive: true });

  const clock = options.clock ?? systemClock;
  const bus = options.bus ?? new Bus();
  const token = await loadOrCreateToken(file(tokenPath));
  const store = new Store({ path: file(dbPath), bus, clock });
  const scheduler = new Scheduler({ store, bus, clock });
  const asks = new Asks({ store, bus, clock });

  let api: ApiServer;
  try {
    scheduler.start();
    api = await startApi({ store, scheduler, asks, token, version: options.version ?? 'dev', portFile: file(portPath) });
  } catch (err) {
    scheduler.stop();
    store.close();
    throw err;
  }

  let stopping: Promise<void> | undefined;
  return {
    store,
    bus,
    scheduler,
    asks,
    api,
    port: api.port,
    token,
    stop() {
      stopping ??= (async () => {
        scheduler.stop();
        asks.dispose();
        await api.close();
        store.close();
      })();
      return stopping;
    },
  };
}
