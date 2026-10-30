/**
 * Wires the core service together: store → bus → scheduler + asks → local API.
 * The Electron main process calls {@link startCore} once at startup.
 */
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appDataDir, dbPath, portPath, tokenPath } from '@clippy/shared';
import { Approvals } from '../approvals/approvals';
import { PowerActions } from '../power/actions';
import type { PowerExecutor } from '../power/executor';
import { startApi, type ApiDeps, type ApiServer } from './api';
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
  /** Is the user at the PC now? Decides away-only notes (see `ApiDeps.isUserActive`). */
  isUserActive?: () => boolean;
  /** Finds a standing order that answers a new ask (see `ApiDeps.matchOrder`). */
  matchOrder?: ApiDeps['matchOrder'];
  /** Longest an ask waits for `matchOrder` (see `ApiDeps.matchOrderTimeoutMs`). */
  matchOrderTimeoutMs?: number;
  /** The `allowPowerActions` setting (restart an app or the PC on request). Default: always off. */
  allowPowerActions?: () => boolean;
  /** What power actions run on. Default: one that refuses everything (tests never touch a real process). */
  powerExecutor?: PowerExecutor;
  /** The `phoneApprovals` setting and the hook both on (agents' permission requests on the phone). Default: always off. */
  approvalsEnabled?: () => boolean;
}

export interface Core {
  store: Store;
  bus: Bus;
  scheduler: Scheduler;
  asks: Asks;
  /** Restart requests the user confirms (see `power/actions.ts`). Its leftovers are expired by `startServices`. */
  power: PowerActions;
  /** Agents' permission requests the user answers from the phone (see `approvals/approvals.ts`). Leftovers are expired by `startServices`. */
  approvals: Approvals;
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
  const power = new PowerActions({
    store,
    bus,
    asks,
    clock,
    allowed: options.allowPowerActions ?? (() => false),
    ...(options.powerExecutor && { executor: options.powerExecutor }),
    log: (message, err) => console.error(`[clippy] ${message}`, err),
  });
  const approvals = new Approvals({
    store,
    bus,
    asks,
    clock,
    enabled: options.approvalsEnabled ?? (() => false),
    ...(options.isUserActive && { isUserActive: options.isUserActive }),
  });

  let api: ApiServer;
  try {
    scheduler.start();
    api = await startApi({
      store,
      scheduler,
      asks,
      power,
      approvals,
      token,
      version: options.version ?? 'dev',
      portFile: file(portPath),
      ...(options.isUserActive && { isUserActive: options.isUserActive }),
      ...(options.matchOrder && { matchOrder: options.matchOrder }),
      ...(options.matchOrderTimeoutMs !== undefined && { matchOrderTimeoutMs: options.matchOrderTimeoutMs }),
    });
  } catch (err) {
    scheduler.stop();
    power.dispose();
    approvals.dispose();
    store.close();
    throw err;
  }

  let stopping: Promise<void> | undefined;
  return {
    store,
    bus,
    scheduler,
    asks,
    power,
    approvals,
    api,
    port: api.port,
    token,
    stop() {
      stopping ??= (async () => {
        scheduler.stop();
        power.dispose();
        approvals.dispose();
        asks.dispose();
        await api.close();
        store.close();
      })();
      return stopping;
    },
  };
}
