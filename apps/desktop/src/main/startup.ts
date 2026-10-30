/**
 * Starts the app's services in an order that loses no WhatsApp or Telegram mirroring:
 *
 * 1. settings (encrypting a plaintext Telegram token) and the brain's config files (async,
 *    before anything is listening);
 * 2. `startCore` (its API is live, and the port file written, when this resolves). Its
 *    scheduler catch-up (reminders missed while the app was off) fires inside it, so the
 *    messages it creates are collected from the bus meanwhile;
 * 3. then **synchronously**, with no `await` in between: the brain, the phone gate, the relay and
 *    Telegram, which subscribe to the bus (the gate first: the two channels mirror on the gate's
 *    `message:mirror`, not on `message:new`); Telegram is then handed the catch-up messages. An agent
 *    (often the MCP server that just launched the app) can post as soon as `/health`
 *    answers; its request is only handled on a later turn of the event loop, by which time
 *    both channels are listening.
 *
 * Electron-free, so the ordering is testable.
 */
import { Bus } from './core/bus';
import { startCore as defaultStartCore, type Core, type StartCoreOptions } from './core/core';
import { Brain, type BrainOptions } from './brain/brain';
import { writeBrainFiles, type McpConfigInput } from './brain/mcpConfig';
import type { Message } from '@clippy/shared';
import { PhoneGate, type PhoneGateOptions } from './phoneGate';
import { RelayManager, type RelayManagerOptions } from './relay';
import { SettingsStore, type SecretBox } from './settings';
import { TelegramManager, type TelegramManagerOptions } from './telegram';

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
  /** Telegram test seams (fake Bot API server, short timings). */
  telegram?: Omit<TelegramManagerOptions, 'store' | 'bus' | 'asks' | 'brain' | 'settings'>;
}

export interface Services {
  core: Core;
  settings: SettingsStore;
  brain: Brain;
  phoneGate: PhoneGate;
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
  let core: Core;
  try {
    core = await (options.startCore ?? defaultStartCore)({
      dataDir: options.dataDir,
      bus,
      ...(idleSeconds && { isUserActive: () => idleSeconds() < settings.get().awayThresholdS }),
      ...(options.version !== undefined && { version: options.version }),
    });
  } finally {
    stopCollecting();
  }

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
  });
  phoneGate.start();
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
  settings.onChange((next) => {
    relay.apply(next);
    telegram.apply();
  });
  return { core, settings, brain, phoneGate, relay, telegram };
}
