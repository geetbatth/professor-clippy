/**
 * Starts the app's services in an order that loses no WhatsApp or Telegram mirroring:
 *
 * 1. settings (encrypting a plaintext Telegram token) and the brain's config files (async,
 *    before anything is listening);
 * 2. `startCore` (its API is live, and the port file written, when this resolves). Its
 *    scheduler catch-up (reminders missed while the app was off) fires inside it, so the
 *    messages it creates are collected from the bus meanwhile. Its standing-order matcher is
 *    handed over here, reading the orders from the core once that exists;
 * 3. then **synchronously**, with no `await` in between: the brain, the phone gate, the watcher, the relay and
 *    Telegram, which subscribe to the bus (the gate first: the two channels mirror on the gate's
 *    `message:mirror`, not on `message:new`); Telegram is then handed the catch-up messages,
 *    restart requests and phone approvals left from before are expired (so the phone copies are updated too), and
 *    the morning brief starts (a late start sends it at once, to listening channels). An agent
 *    (often the MCP server that just launched the app) can post as soon as `/health`
 *    answers; its request is only handled on a later turn of the event loop, by which time
 *    both channels are listening.
 *
 * Electron-free, so the ordering is testable.
 */
import { BriefScheduler, type BriefSchedulerOptions } from './brief';
import { Bus } from './core/bus';
import { startCore as defaultStartCore, type Core, type StartCoreOptions } from './core/core';
import { Brain, type BrainOptions } from './brain/brain';
import { writeBrainFiles, type McpConfigInput } from './brain/mcpConfig';
import type { Message } from '@clippy/shared';
import { createOrderMatcher } from './orders';
import { PhoneGate, type PhoneGateOptions } from './phoneGate';
import type { PowerExecutor } from './power/executor';
import { RelayManager, type RelayManagerOptions } from './relay';
import { SettingsStore, type SecretBox } from './settings';
import { TelegramManager, type TelegramManagerOptions } from './telegram';
import { Watcher } from './watches';

export interface StartServicesOptions {
  dataDir: string;
  /** `settings.json` (the shared `settingsPath()` in the app). */
  settingsFile: string;
  version?: string;
  /** Bus with the renderer forwarding already attached. */
  bus?: Bus;
  /** Built MCP server for the brain; undefined runs the brain without clippy tools. */
  mcp?: McpConfigInput | undefined;
  /** Brain options other than the store and its config files (emit, runner, cwd, ...). */
  brain: Omit<BrainOptions, 'store' | 'mcpConfigPath' | 'settingsPath'>;
  /** Test seams. */
  startCore?: (options: StartCoreOptions) => Promise<Core>;
  makeTransport?: RelayManagerOptions['makeTransport'];
  relayLog?: RelayManagerOptions['log'];
  /** Encrypts the Telegram bot token at rest (Electron `safeStorage` in the app). */
  secrets?: SecretBox;
  /**
   * Seconds since the last keyboard or mouse input (Electron `powerMonitor.getSystemIdleTime`).
   * With it, away-only notes are quiet while that is under the `awayThresholdS` setting, and
   * notes only go to the phone once the user is away (the `phoneWhen` setting).
   * Without it, every note interrupts and goes to the phone at once.
   */
  idleSeconds?: () => number;
  /** Phone gate tick (test seam). */
  phoneGate?: Pick<PhoneGateOptions, 'clock' | 'tickMs'>;
  /**
   * What restarting an app or the PC runs on (the Windows one in the app). Default: one that
   * refuses everything, so tests never touch a real process.
   */
  powerExecutor?: PowerExecutor;
  /** Morning brief clock (test seam). */
  brief?: Pick<BriefSchedulerOptions, 'clock'>;
  /** Telegram test seams (fake Bot API server, short timings). */
  telegram?: Omit<TelegramManagerOptions, 'store' | 'bus' | 'asks' | 'brain' | 'settings'>;
}

export interface Services {
  core: Core;
  settings: SettingsStore;
  brain: Brain;
  phoneGate: PhoneGate;
  watcher: Watcher;
  brief: BriefScheduler;
  relay: RelayManager;
  telegram: TelegramManager;
}

export async function startServices(options: StartServicesOptions): Promise<Services> {
  const settings = await SettingsStore.load(options.settingsFile, { ...(options.secrets && { secrets: options.secrets }) });
  const brainFiles = await writeBrainFiles(options.dataDir, options.mcp);
  const bus = options.bus ?? new Bus();
  // Reminders the scheduler catches up on inside startCore (missed while the app was off):
  // Telegram has no Worker to have sent them, so it gets them once it is listening.
  const early: Message[] = [];
  const stopCollecting = bus.on('message:new', (m) => early.push(m));
  const idleSeconds = options.idleSeconds;
  // Standing orders answer an agent's question before the user sees it. The matcher runs in the
  // brain's setup (same CLI runner, folder and environment, hooks off); the orders come from the
  // core, which does not exist yet when the API goes live.
  const matcher = createOrderMatcher({
    ...(options.brain.runner && { runner: options.brain.runner }),
    ...(options.brain.env && { env: options.brain.env }),
    ...(options.brain.cwd !== undefined && { cwd: options.brain.cwd }),
    settingsPath: brainFiles.settingsPath,
  });
  let started: Core | undefined;
  let core: Core;
  try {
    core = await (options.startCore ?? defaultStartCore)({
      dataDir: options.dataDir,
      bus,
      matchOrder: async (input) => {
        const orders = started?.store.listActiveOrders() ?? [];
        return orders.length === 0 ? undefined : matcher(input.question, input.options, orders);
      },
      ...(idleSeconds && { isUserActive: () => idleSeconds() < settings.get().awayThresholdS }),
      allowPowerActions: () => settings.get().allowPowerActions,
      // Phone approvals need the hook too: it is what asks, and turning it off should stop them.
      approvalsEnabled: () => settings.get().phoneApprovals && settings.get().hookEnabled,
      ...(options.powerExecutor && { powerExecutor: options.powerExecutor }),
      ...(options.version !== undefined && { version: options.version }),
    });
  } finally {
    stopCollecting();
  }

  started = core;

  // ---- no await from here on: the API is live ----
  const brain = new Brain({
    ...options.brain,
    store: core.store,
    mcpConfigPath: brainFiles.mcpConfigPath,
    settingsPath: brainFiles.settingsPath,
  });
  // Away = no input for `awayThresholdS` (0: always away). Without an idle source, always away.
  const isUserAway = idleSeconds
    ? () => settings.get().awayThresholdS === 0 || idleSeconds() >= settings.get().awayThresholdS
    : () => true;
  const phoneGate = new PhoneGate({
    ...options.phoneGate,
    bus,
    store: core.store,
    isUserAway,
    mode: () => settings.get().phoneWhen,
    // A question goes to the phone after half the time ask_user waits for an answer.
    askEscalateMs: () => settings.get().askTimeoutDefaultS * 500,
  });
  phoneGate.start();
  // Nudges from watches are ordinary notes from Clippy, so they reach the gate like any other.
  const watcher = new Watcher({ bus, store: core.store });
  watcher.start();
  const relay = new RelayManager({
    store: core.store,
    bus,
    scheduler: core.scheduler,
    asks: core.asks,
    brain,
    ...(options.makeTransport && { makeTransport: options.makeTransport }),
    ...(options.relayLog && { log: options.relayLog }),
  });
  relay.apply(settings.get());
  const telegram = new TelegramManager({
    ...options.telegram,
    store: core.store,
    bus,
    asks: core.asks,
    brain,
    settings,
  });
  telegram.apply();
  telegram.replay(early);
  // Restart questions from before this start must not look live: answered "Expired" now that
  // Telegram listens (its copy loses its buttons); nothing is run.
  core.power.expireLeftovers();
  // Likewise approvals: their agents gave up when Clippy went away (no decision, the terminal prompt shows).
  core.approvals.expireLeftovers();
  // The morning brief is a note from Clippy too, and if it is due now (a late start) it is sent
  // here, once the relay and Telegram are listening for what the gate mirrors.
  const brief = new BriefScheduler({ ...options.brief, store: core.store, settings: () => settings.get() });
  brief.start();
  settings.onChange((next, prev) => {
    relay.apply(next);
    telegram.apply();
    if (next.briefEnabled !== prev.briefEnabled || next.briefTime !== prev.briefTime || next.briefWeekdaysOnly !== prev.briefWeekdaysOnly) {
      brief.reschedule();
    }
  });
  return { core, settings, brain, phoneGate, watcher, brief, relay, telegram };
}
