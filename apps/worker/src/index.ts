/**
 * Professor Clippy relay Worker. Fronts the WhatsApp Cloud API and talks to the
 * desktop app using the protocol in `@clippy/shared/relay`. All state lives in the
 * single `ClippyDO`; this file authenticates and routes.
 * Import only Node-free subpaths of @clippy/shared here (`/relay`, `/schemas`).
 */
import { RelayReminderPut, RelayRoutes, RelaySendRequest } from '@clippy/shared/relay';
import type { ClippyDO } from './do';
import { parseRule } from './recurrence';
import { isAuthorizedPc, secretEquals, verifyMetaSignature } from './security';
import { extractInboundTexts } from './webhook';

export { ClippyDO } from './do';

/** Worker bindings (see wrangler.toml) and secrets (see README.md). */
export interface Env {
  /** The single SQLite-backed relay Durable Object. */
  CLIPPY: DurableObjectNamespace<ClippyDO>;
  /** Meta system-user access token (whatsapp_business_messaging). */
  META_TOKEN: string;
  /** Meta app secret: key for the webhook `X-Hub-Signature-256`. */
  APP_SECRET: string;
  /** Token Meta echoes in the webhook verify handshake. */
  VERIFY_TOKEN: string;
  /** Bearer secret the desktop app uses (Settings.workerSecret). */
  PC_SECRET: string;
  /** WhatsApp Business phone number id (sender). */
  PHONE_NUMBER_ID: string;
  /** The user's own WhatsApp number (only recipient and only accepted sender). */
  MY_NUMBER: string;
}

/** Name of the one relay Durable Object instance. */
const DO_NAME = 'relay';

const REMINDER_PATH = /^\/reminders\/([^/]+)$/;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function error(status: number, message: string): Response {
  return json({ error: message }, status);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** `GET /webhook`: Meta's subscription handshake. */
async function verifyHandshake(url: URL, env: Env): Promise<Response> {
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge') ?? '';
  if (mode === 'subscribe' && (await secretEquals(env.VERIFY_TOKEN, token))) {
    return new Response(challenge, { status: 200, headers: { 'content-type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

/** `POST /webhook`: signed delivery from Meta. Always 200 once the signature is valid. */
async function receiveWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.arrayBuffer();
  if (!(await verifyMetaSignature(env.APP_SECRET, raw, request.headers.get('x-hub-signature-256')))) {
    return new Response('Forbidden', { status: 403 });
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return new Response('OK');
  }
  const items = extractInboundTexts(payload, env.MY_NUMBER ?? '', Date.now());
  if (items.length > 0) await env.CLIPPY.getByName(DO_NAME).ingestInbound(items);
  return new Response('OK');
}

/** Bearer-authenticated routes used by the desktop app. */
async function pcRoute(request: Request, url: URL, env: Env): Promise<Response | undefined> {
  const path = url.pathname;
  const reminderMatch = REMINDER_PATH.exec(path);
  const isPcPath = path === RelayRoutes.send.path || path === RelayRoutes.ws.path || reminderMatch !== null;
  if (!isPcPath) return undefined;
  if (!(await isAuthorizedPc(env.PC_SECRET, request.headers.get('authorization')))) {
    return error(401, 'Unauthorized');
  }
  const stub = env.CLIPPY.getByName(DO_NAME);
  const method = request.method;

  if (path === RelayRoutes.send.path && method === RelayRoutes.send.method) {
    const body = RelaySendRequest.safeParse(await readJson(request));
    if (!body.success) return error(400, body.error.message);
    const result = await stub.send(body.data);
    return 'error' in result ? error(502, result.error) : json(result);
  }

  if (path === RelayRoutes.ws.path && method === RelayRoutes.ws.method) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return error(426, 'Expected WebSocket upgrade');
    }
    return stub.fetch(request);
  }

  if (reminderMatch) {
    let id: string;
    try {
      id = decodeURIComponent(reminderMatch[1] ?? '');
    } catch {
      return error(400, 'Bad reminder id');
    }
    if (method === RelayRoutes.putReminder.method) {
      const body = RelayReminderPut.safeParse(await readJson(request));
      if (!body.success) return error(400, body.error.message);
      if (body.data.rrule !== undefined) {
        try {
          parseRule(body.data.rrule, body.data.dueAt);
        } catch (err) {
          return error(400, err instanceof Error ? err.message : String(err));
        }
      }
      await stub.putReminder(id, body.data);
      return new Response(null, { status: 204 });
    }
    if (method === RelayRoutes.deleteReminder.method) {
      await stub.deleteReminder(id);
      return new Response(null, { status: 204 });
    }
  }

  return error(405, 'Method not allowed');
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return json({ ok: true });
    if (url.pathname === '/webhook') {
      if (request.method === 'GET') return verifyHandshake(url, env);
      if (request.method === 'POST') return receiveWebhook(request, env);
      return new Response('Method not allowed', { status: 405 });
    }
    return (await pcRoute(request, url, env)) ?? new Response('Not found', { status: 404 });
  },
} satisfies ExportedHandler<Env>;
