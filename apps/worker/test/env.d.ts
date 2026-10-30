// Types for `cloudflare:workers` `env` / `exports` inside tests.
import type { Env as WorkerEnv } from '../src/index';

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    interface GlobalProps {
      mainModule: typeof import('../src/index');
    }
  }
}
