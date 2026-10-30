/**
 * Watches: "when the Clippy agent finishes, remind me to deploy". A watch waits for a note (or
 * question) from a matching agent and, the first time one arrives, posts the user's nudge as a
 * note from Clippy and retires itself.
 *
 * It listens to `message:new`, so the hook's away-only "agent finished" notes count even when the
 * user was at the PC and they were filed straight into history. The nudge is an ordinary note from
 * Clippy: loud on the desk, and mirrored to the phone by the phone gate when the user is away.
 *
 * Electron-free; no timers, so there is nothing to outlive the store.
 */
import { BRAIN_SENDER, type Message, type Watch } from '@clippy/shared';
import type { Bus } from './core/bus';
import { systemClock, type Clock } from './core/clock';
import type { Store } from './core/store';
import { POWER_SENDER } from './power/actions';

/** Sender of the nudge notes (Clippy's own). */
const NUDGE_SENDER = 'clippy';
const NUDGE_TITLE = '⏰ Nudge';

/**
 * The watches a new message triggers: Clippy's own notes and questions (nudges, the brain's,
 * restart confirmations) never do, chat and reminders never do.
 */
export function matchWatches(watches: Watch[], m: Pick<Message, 'kind' | 'project' | 'event' | 'sender'>): Watch[] {
  if (m.sender === NUDGE_SENDER || m.sender === BRAIN_SENDER || m.sender === POWER_SENDER || (m.kind !== 'note' && m.kind !== 'ask')) return [];
  const project = m.project?.toLowerCase();
  return watches.filter((w) => {
    if (w.project !== undefined && !project?.includes(w.project.toLowerCase())) return false;
    return w.event === 'any' || m.event === 'agent-finished';
  });
}

/** The line under the nudge saying what set it off. */
function trigger(m: Message): string {
  const who = m.project ? `${m.project} agent` : 'an agent';
  if (m.event === 'agent-finished') return `${who} finished`;
  if (m.event === 'agent-needs-permission') return `${who} needs permission`;
  return m.kind === 'ask' ? `${who} asked a question` : `${who} left a note`;
}

export interface WatcherOptions {
  bus: Bus;
  store: Store;
  clock?: Clock;
}

export class Watcher {
  readonly #o: WatcherOptions;
  readonly #clock: Clock;
  #off: (() => void) | undefined;

  constructor(options: WatcherOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  start(): void {
    this.#off ??= this.#o.bus.on('message:new', (m) => this.#onNew(m));
  }

  stop(): void {
    this.#off?.();
    this.#off = undefined;
  }

  #onNew(m: Message): void {
    const { store } = this.#o;
    for (const watch of matchWatches(store.listActiveWatches(), m)) {
      // One transaction: the watch is spent only if its nudge is stored, and a watch that is no
      // longer active (fired or cancelled meanwhile) is skipped, so it fires exactly once.
      try {
        store.transaction(() => {
          if (!store.fireWatch(watch.id, this.#clock.now())) return;
          store.createMessage({ kind: 'note', sender: NUDGE_SENDER, title: NUDGE_TITLE, body: `${watch.nudge}\n(${trigger(m)})` });
        });
      } catch (err) {
        console.error('[clippy] watch nudge failed:', err); // the watch stays active for the next match
      }
    }
  }
}
