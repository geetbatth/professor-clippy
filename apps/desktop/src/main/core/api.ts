/**
 * Local HTTP API (contract: `Routes` in `@clippy/shared/api`), consumed by
 * `ClippyClient` (MCP server, hook).
 *
 * - Binds 127.0.0.1 only, on a random free port that is written to the port file.
 * - Every request needs `Authorization: Bearer <token>` (401 otherwise).
 * - Bodies/queries are validated with the shared zod schemas (400 `{error}`).
 * - `GET /asks/:id?wait=<s>` long-polls. `wait` must be a non-negative number of
 *   seconds (anything else is a 400); values above `MAX_LONG_POLL_S` are clamped
 *   to it. Missing/empty `wait` means 0 (answer immediately).
 */
import { timingSafeEqual } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AnswerAskBody,
  MATCH_ORDER_TIMEOUT_MS,
  MAX_LONG_POLL_S,
  MessageFilter,
  NewAskInput,
  NewMessageInput,
  NewReminderInput,
  NewStandingOrderInput,
  Routes,
  SnoozeBody,
  type Health,
  type RouteDef,
} from '@clippy/shared';
import { z } from 'zod';
import type { Asks } from './asks';
import { CoreError, NotFoundError, ValidationError } from './errors';
import { writeAtomic } from './files';
import type { Scheduler } from './scheduler';
import type { Store } from './store';

/** Largest accepted request body. */
const MAX_BODY_BYTES = 1024 * 1024;
/** How long `close()` waits for in-flight requests before dropping connections. */
const CLOSE_GRACE_MS = 1000;

export interface ApiDeps {
  store: Store;
  scheduler: Scheduler;
  asks: Asks;
  /** Bearer token every request must present. */
  token: string;
  /** Reported by `GET /health`. */
  version: string;
  /**
   * Is the user at the PC right now (input within the away threshold)? Decides where an
   * away-only note (`quietIfActive`) goes. Absent: treated as away (every note interrupts).
   */
  isUserActive?: () => boolean;
  /**
   * Finds a standing order that answers a new ask. A match answers the ask on the spot; no match,
   * a rejection or taking longer than `matchOrderTimeoutMs` posts it as a normal question.
   */
  matchOrder?: (input: NewAskInput) => Promise<{ orderId: string; answer: string } | undefined>;
  /** Default {@link MATCH_ORDER_TIMEOUT_MS} (a test seam). */
  matchOrderTimeoutMs?: number;
}

export interface StartApiOptions extends ApiDeps {
  /** Port to bind; default 0 (random free port). */
  port?: number;
  /** If set, the bound port is written here (and removed again on close). */
  portFile?: string;
}

export interface ApiServer {
  readonly port: number;
  /** Stop listening and drop open connections (including pending long-polls). */
  close(): Promise<void>;
}

interface RequestContext {
  req: IncomingMessage;
  url: URL;
  /** Decoded `:id` path parameter, if the route has one. */
  id: string;
  /** Aborted when the client goes away. */
  signal: AbortSignal;
}

interface Reply {
  status: number;
  body?: unknown;
}

type Handler = (ctx: RequestContext) => Reply | Promise<Reply>;

/** Build the request listener (no I/O besides the request itself; handy for tests). */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const { store, scheduler, asks } = deps;
  const expectedAuth = Buffer.from(`Bearer ${deps.token}`);

  // Order matters: `/asks/pending` must match before `/asks/:id`.
  const routes = compileRoutes([
    [Routes.health, (): Reply => ok({ ok: true, version: deps.version } satisfies Health)],
    [
      Routes.postMessage,
      async ({ req }) => {
        const input = await body(req, NewMessageInput);
        // An away-only note while the user is at the PC goes straight into history: no pop-up,
        // sound or badge (the renderer only reacts to unread notes), and no phone mirror (the
        // relay and Telegram skip notes that are already done).
        const quiet = input.quietIfActive === true && (deps.isUserActive?.() ?? false);
        return created(store.createMessage({ kind: 'note', ...input, ...(quiet && { state: 'done' }) }));
      },
    ],
    [Routes.listMessages, ({ url }) => ok(store.listMessages(parse(MessageFilter, query(url, ['state', 'kind', 'q']))))],
    [Routes.markDone, ({ id }) => ok(found(store.markDone(id), 'message', id))],
    [Routes.snooze, async ({ req, id }) => ok(found(store.snooze(id, (await body(req, SnoozeBody)).until), 'message', id))],
    [Routes.createReminder, async ({ req }) => created(scheduler.create(await body(req, NewReminderInput)))],
    [Routes.listReminders, () => ok(scheduler.list())],
    [Routes.cancelReminder, ({ id }) => (scheduler.cancel(id), { status: 204 })],
    [
      Routes.createAsk,
      async ({ req, signal }) => {
        const input = await body(req, NewAskInput);
        const match = await matchStandingOrder(input);
        // The agent gave up while we were matching: storing the ask now would orphan it (a retry would duplicate it).
        if (signal.aborted) return { status: 499 };
        return created(asks.create(input, match));
      },
    ],
    [Routes.listPendingAsks, () => ok(asks.listPending())],
    [Routes.getAsk, async ({ id, url, signal }) => ok(await asks.wait(id, parseWait(url.searchParams.get('wait')) * 1000, signal))],
    [
      Routes.answerAsk,
      async ({ req, id }) => {
        const { answer, via } = await body(req, AnswerAskBody);
        return ok(asks.answer(id, answer, via));
      },
    ],
    [Routes.listOrders, () => ok(store.listActiveOrders())],
    [Routes.addOrder, async ({ req }) => created(store.insertOrder((await body(req, NewStandingOrderInput)).text))],
    [Routes.cancelOrder, ({ id }) => (found(store.cancelOrder(id), 'order', id), { status: 204 })],
  ]);

  return (req, res) => {
    void (async () => {
      let reply: Reply;
      try {
        reply = await dispatch(req, res);
      } catch (err) {
        if (err instanceof CoreError) reply = { status: err.status, body: { error: err.message } };
        else {
          console.error('[clippy] API error:', err);
          reply = { status: 500, body: { error: 'Internal error' } };
        }
      }
      send(res, reply);
    })();
  };

  /** A standing order's answer to a new ask, if one is found in time. Never rejects. */
  async function matchStandingOrder(input: NewAskInput): Promise<{ orderId: string; answer: string } | undefined> {
    if (!deps.matchOrder) return undefined;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, deps.matchOrderTimeoutMs ?? MATCH_ORDER_TIMEOUT_MS, undefined);
    });
    try {
      return await Promise.race([deps.matchOrder(input), timedOut]);
    } catch {
      return undefined; // no order is better than no ask
    } finally {
      clearTimeout(timer);
    }
  }

  async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<Reply> {
    if (!authorized(req.headers.authorization)) return { status: 401, body: { error: 'Unauthorized' } };
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    for (const route of routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(url.pathname);
      if (!match) continue;
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      return route.handler({ req, url, id: decodeId(match[1]), signal: controller.signal });
    }
    return { status: 404, body: { error: `No route for ${req.method} ${url.pathname}` } };
  }

  function authorized(header: string | undefined): boolean {
    if (header === undefined) return false;
    const given = Buffer.from(header);
    return given.length === expectedAuth.length && timingSafeEqual(given, expectedAuth);
  }
}

/** Start the API on 127.0.0.1 and (optionally) write the bound port to `portFile`. */
export async function startApi(options: StartApiOptions): Promise<ApiServer> {
  const handler = createApiHandler(options);
  const inFlight = new Set<ServerResponse>();
  let onDrained: (() => void) | undefined;
  const server: Server = createServer((req, res) => {
    inFlight.add(res);
    res.once('close', () => {
      inFlight.delete(res);
      if (inFlight.size === 0) onDrained?.();
    });
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  if (options.portFile) await writeAtomic(options.portFile, String(port));

  let closing: Promise<void> | undefined;
  return {
    port,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        // Let in-flight requests (e.g. long-polls just released by asks.dispose()) finish,
        // without keep-alive, for up to CLOSE_GRACE_MS...
        for (const res of inFlight) if (!res.headersSent) res.setHeader('connection', 'close');
        await new Promise<void>((resolve) => {
          if (inFlight.size === 0) return resolve();
          onDrained = resolve;
          setTimeout(resolve, CLOSE_GRACE_MS).unref();
        });
        // ...then drop everything else (idle keep-alive sockets, connections that never sent a request).
        server.closeAllConnections();
        await closed;
        if (options.portFile) await removePortFile(options.portFile, port);
      })();
      return closing;
    },
  };
}

// ---- helpers ----------------------------------------------------------------

function compileRoutes(table: [RouteDef, Handler][]): { method: string; pattern: RegExp; handler: Handler }[] {
  return table.map(([route, handler]) => ({
    method: route.method,
    pattern: new RegExp(`^${route.path.replace(':id', '([^/]+)')}$`),
    handler,
  }));
}

function decodeId(raw: string | undefined): string {
  if (raw === undefined) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new ValidationError('Malformed id in path');
  }
}

function ok(body: unknown): Reply {
  return { status: 200, body };
}

function created(body: unknown): Reply {
  return { status: 201, body };
}

function found<T>(value: T | undefined, what: string, id: string): T {
  if (value === undefined) throw new NotFoundError(`No ${what} ${id}`);
  return value;
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ValidationError(z.prettifyError(result.error));
  return result.data;
}

/** Selected query parameters as an object (absent ones omitted). */
function query(url: URL, keys: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

/** `wait` query value in seconds, clamped to MAX_LONG_POLL_S. */
export function parseWait(raw: string | null): number {
  if (raw === null || raw === '') return 0;
  if (!/^\d+(\.\d+)?$/.test(raw)) throw new ValidationError('wait must be a non-negative number of seconds');
  return Math.min(Number(raw), MAX_LONG_POLL_S);
}

/** Read, size-limit, JSON-parse and validate the request body. */
async function body<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // Keep draining (and discarding) an oversized body so the client gets the 400, not a reset.
    if (size <= MAX_BODY_BYTES) chunks.push(chunk as Buffer);
  }
  if (size > MAX_BODY_BYTES) throw new ValidationError('Request body too large (max 1 MiB)');
  let json: unknown;
  try {
    json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('Request body must be valid JSON');
  }
  return parse(schema, json);
}

function send(res: ServerResponse, reply: Reply): void {
  if (res.destroyed || res.writableEnded) return; // client went away (e.g. long-poll aborted)
  if (reply.body === undefined) {
    res.writeHead(reply.status).end();
    return;
  }
  const payload = JSON.stringify(reply.body);
  res
    .writeHead(reply.status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    })
    .end(payload);
}

/** Remove the port file unless another instance has since overwritten it. */
async function removePortFile(file: string, port: number): Promise<void> {
  try {
    if ((await readFile(file, 'utf8')).trim() === String(port)) await rm(file, { force: true });
  } catch {
    // Already gone.
  }
}
