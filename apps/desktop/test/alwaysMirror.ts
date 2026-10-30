import type { Bus } from '../src/main/core/bus';
import type { Store } from '../src/main/core/store';
import { PhoneGate } from '../src/main/phoneGate';

/**
 * A phone gate that never holds anything: every note, ask and reminder is announced on
 * `message:mirror` as it arrives, like the app with the "Always" setting. For the relay and
 * Telegram tests, which mirror on that event. Call the returned function to stop it.
 */
export function alwaysMirror(bus: Bus, store: Store): () => void {
  const gate = new PhoneGate({ bus, store, isUserAway: () => true, mode: () => 'always' });
  gate.start();
  return () => gate.stop();
}
