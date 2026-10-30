/**
 * Professor Clippy relay Worker (skeleton). Fronts the WhatsApp Cloud API and
 * talks to the desktop app using the protocol in `@clippy/shared/relay`.
 * Import only Node-free subpaths of @clippy/shared here (`/relay`, `/schemas`).
 */
import { DurableObject } from 'cloudflare:workers';

/** Worker bindings (see wrangler.toml). */
export interface Env {
  /** The single SQLite-backed relay Durable Object. */
  CLIPPY: DurableObjectNamespace<ClippyDO>;
}

/** The one relay Durable Object (SQLite storage backend). */
export class ClippyDO extends DurableObject<Env> {}

export default {
  async fetch(request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    return new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
