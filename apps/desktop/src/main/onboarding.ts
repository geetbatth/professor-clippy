/**
 * The welcome's Getting started list and tips: what the user has tried, kept in kv `onboarding`
 * (`OnboardingState`). Items tick themselves from bus events:
 *
 * - `answer`: an ask answered by the user (desk, Telegram, WhatsApp; not `via: 'clippy'`);
 * - `snooze`: a message snoozed;
 * - `order`: a standing order added;
 * - `popout`: a page popped out onto the desktop;
 * - `brief`: a morning brief note left.
 *
 * `connect` is ticked by the backend when "Connect Claude Code" installs (or at start when the hook
 * wiring is already there), and `hotkey` and the welcome's practice question by the renderer
 * (`markOnboarding`). The first start of this version sets `startedAt`, so tips (renderer,
 * `note/welcome/tips.ts`) run for two weeks from then, for existing users too. Every change is
 * stored and emitted as `onboarding:changed`.
 *
 * Electron-free; no timers.
 */
import { ChecklistItem, OnboardingState, type TipId } from '@clippy/shared';
import { isBriefNote } from './brief';
import type { Bus } from './core/bus';
import { systemClock, type Clock } from './core/clock';
import type { Store } from './core/store';

export const ONBOARDING_KV = 'onboarding';

export interface OnboardingOptions {
  bus: Bus;
  store: Pick<Store, 'getKv' | 'setKv'>;
  clock?: Clock;
}

export class Onboarding {
  readonly #o: OnboardingOptions;
  readonly #clock: Clock;
  #state: OnboardingState | undefined;
  #offs: (() => void)[] = [];

  constructor(options: OnboardingOptions) {
    this.#o = options;
    this.#clock = options.clock ?? systemClock;
  }

  /** Load (or begin) the record and listen to the bus. */
  start(): void {
    this.state();
    if (this.#offs.length > 0) return;
    const { bus } = this.#o;
    this.#offs = [
      bus.on('ask:answered', ({ result }) => {
        if (result.answeredVia !== undefined && result.answeredVia !== 'clippy') this.mark('answer');
      }),
      bus.on('message:updated', (m) => {
        if (m.state === 'snoozed') this.mark('snooze');
      }),
      bus.on('order:added', () => this.mark('order')),
      bus.on('page:changed', (page) => {
        if (page.popped) this.mark('popout');
      }),
      bus.on('message:new', (m) => {
        if (isBriefNote(m)) this.mark('brief');
      }),
    ];
  }

  stop(): void {
    for (const off of this.#offs) off();
    this.#offs = [];
  }

  state(): OnboardingState {
    this.#state ??= this.#load();
    return structuredClone(this.#state);
  }

  /** Tick an item (once; ticking it again changes nothing). */
  mark(item: ChecklistItem): OnboardingState {
    const state = this.state();
    if (state.done.includes(item)) return state;
    // Kept in the list's own order, whatever order they happen in.
    const done = new Set([...state.done, item]);
    return this.#save({ ...state, done: ChecklistItem.options.filter((i) => done.has(i)) });
  }

  /** The × on the Pad's Getting started row. */
  dismiss(): OnboardingState {
    const state = this.state();
    return state.dismissed ? state : this.#save({ ...state, dismissed: true });
  }

  /** "Run the welcome again": the list comes back; what was done stays done. (The wizard itself is the `firstRunDone` setting.) */
  restartWelcome(): OnboardingState {
    const state = this.state();
    return state.dismissed ? this.#save({ ...state, dismissed: false }) : state;
  }

  /** A tip was shown: never again, and the hour before the next one starts now. */
  tipShown(id: TipId): OnboardingState {
    const state = this.state();
    const tipsShown = state.tipsShown.includes(id) ? state.tipsShown : [...state.tipsShown, id];
    return this.#save({ ...state, tipsShown, lastTipAt: this.#clock.now() });
  }

  #load(): OnboardingState {
    const raw = this.#o.store.getKv(ONBOARDING_KV);
    if (raw !== undefined) {
      try {
        const parsed = OnboardingState.safeParse(JSON.parse(raw));
        if (parsed.success) return parsed.data;
      } catch {
        // damaged: start afresh below
      }
      console.warn('[clippy] onboarding record unreadable; starting it afresh');
    }
    const fresh: OnboardingState = { startedAt: this.#clock.now(), done: [], dismissed: false, tipsShown: [] };
    this.#o.store.setKv(ONBOARDING_KV, JSON.stringify(fresh));
    return fresh;
  }

  #save(next: OnboardingState): OnboardingState {
    this.#o.store.setKv(ONBOARDING_KV, JSON.stringify(next));
    this.#state = next;
    const copy = structuredClone(next);
    this.#o.bus.emit('onboarding:changed', copy);
    return structuredClone(next);
  }
}
