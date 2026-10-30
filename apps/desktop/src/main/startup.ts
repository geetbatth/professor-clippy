/**
 * Starts the app's services in an order that loses no WhatsApp mirroring:
 *
 * 1. settings and the brain's config files (async, before anything is listening);
 * 2. `startCore` (its API is live, and the port file written, when this resolves);
 * 3. then **synchronously**, with no `await` in between: the brain and the relay, which
 *    subscribes to the bus. An agent (often the MCP server that just launched the app) can
 *    post as soon as `/health` answers; its request is only handled on a later turn of the
 *    event loop, by which time the relay is listening.
 *
 * Electron-free, so the ordering is testable.
 */
import { Bus } from './core/bus';
import { startCore as defaultStartCore, type Core, type StartCoreOptions } from './core/core';
import { Brain, type BrainOptions } from './brain/brain';
import { writeBrainFiles, type McpConfigInput } from './brain/mcpConfig';
import { RelayManager, type RelayManagerOptions } from './relay';
import { SettingsStore } from './settings';

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
}

export interface Services {
  core: Core;
  settings: SettingsStore;
  brain: Brain;
  relay: RelayManager;
}

export async function startServices(options: StartServicesOptions): Promise<Services> {
  const settings = await SettingsStore.load(options.settingsFile);
  const brainFiles = await writeBrainFiles(options.dataDir, options.mcp);
  const bus = options.bus ?? new Bus();
  const core = await (options.startCore ?? defaultStartCore)({
    dataDir: options.dataDir,
    bus,
    ...(options.version !== undefined && { version: options.version }),
  });

  // ---- no await from here on: the API is live ----
  const brain = new Brain({
    ...options.brain,
    store: core.store,
    mcpConfigPath: brainFiles.mcpConfigPath,
    settingsPath: brainFiles.settingsPath,
  });
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
  settings.onChange((next) => relay.apply(next));
  return { core, settings, brain, relay };
}
