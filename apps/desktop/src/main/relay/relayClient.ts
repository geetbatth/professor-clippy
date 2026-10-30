/**
 * Transport to the Cloudflare relay Worker: REST calls plus one outbound WebSocket.
 *
 * - `GET ${workerUrl}/ws` (https → wss) with `Authorization: Bearer <secret>`.
 * - Reconnects with exponential backoff, 1 s doubling to 60 s; the delay resets after a
 *   successful open. A ping every 30 s; no pong by the next ping drops the socket.
 * - Frames are parsed with the shared `WorkerToPc` schema and handled one at a time, in order.
 *   A frame's id is acked only after its handler resolves; a handler that throws leaves it
 *   unacked, so the Worker redelivers it on the next connect.
 */
import WebSocket from 'ws';
import {
  RelayRoutes,
  RelaySendResponse,
  WorkerToPc,
  type RelayReminderPut,
  type RelaySendRequest,
} from '@clippy/shared';

export const BACKOFF_MIN_MS = 1000;
export const BACKOFF_MAX_MS = 60_000;
export const PING_INTERVAL_MS = 30_000;
export const REQUEST_TIMEOUT_MS = 15_000;

export type FrameHandler = (frame: WorkerToPc) => Promise<void>;

/** What the relay logic needs from the transport (faked in tests). */
export interface RelayTransport {
  start(onFrame: FrameHandler): void;
  stop(): void;
  send(request: RelaySendRequest): Promise<RelaySendResponse>;
  putReminder(id: string, body: RelayReminderPut): Promise<void>;
  deleteReminder(id: string): Promise<void>;
}

/** A non-2xx answer from the Worker. 4xx other than 408/429 won't succeed on retry. */
export class RelayHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }

  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

export interface RelayClientOptions {
  workerUrl: string;
  workerSecret: string;
  fetch?: typeof fetch;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
  requestTimeoutMs?: number;
  log?: (message: string, err?: unknown) => void;
}

/** Reconnect delay before attempt `attempt` (0-based): `min` doubling, capped at `max`. */
export function backoffDelay(attempt: number, min = BACKOFF_MIN_MS, max = BACKOFF_MAX_MS): number {
  return Math.min(max, min * 2 ** Math.min(attempt, 30));
}

/** `https://x.workers.dev/base` + `/ws` → `wss://x.workers.dev/base/ws`. */
export function relayUrl(base: string, path: string, protocol: 'http' | 'ws' = 'http'): string {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  url.search = '';
  url.hash = '';
  if (protocol === 'ws') url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  return url.toString();
}

export class RelayClient implements RelayTransport {
  readonly #o: Required<Omit<RelayClientOptions, 'log'>> & Pick<RelayClientOptions, 'log'>;
  #onFrame: FrameHandler | undefined;
  #ws: WebSocket | undefined;
  #running = false;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  /** Frames are handled strictly in order. */
  #chain: Promise<void> = Promise.resolve();

  constructor(options: RelayClientOptions) {
    this.#o = {
      fetch: globalThis.fetch.bind(globalThis),
      backoffMinMs: BACKOFF_MIN_MS,
      backoffMaxMs: BACKOFF_MAX_MS,
      pingIntervalMs: PING_INTERVAL_MS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      ...options,
    };
  }

  /** True while the WebSocket is open. */
  get connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  start(onFrame: FrameHandler): void {
    if (this.#running) return;
    this.#running = true;
    this.#onFrame = onFrame;
    this.#connect();
  }

  stop(): void {
    this.#running = false;
    clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
    this.#closeSocket();
  }

  // ---- REST -----------------------------------------------------------------

  async send(request: RelaySendRequest): Promise<RelaySendResponse> {
    const res = await this.#request(RelayRoutes.send.method, RelayRoutes.send.path, request);
    return RelaySendResponse.parse(await res.json());
  }

  async putReminder(id: string, body: RelayReminderPut): Promise<void> {
    await this.#request('PUT', RelayRoutes.putReminder.path.replace(':id', encodeURIComponent(id)), body);
  }

  async deleteReminder(id: string): Promise<void> {
    await this.#request('DELETE', RelayRoutes.deleteReminder.path.replace(':id', encodeURIComponent(id)));
  }

  async #request(method: string, path: string, body?: unknown): Promise<Response> {
    const res = await this.#o.fetch(relayUrl(this.#o.workerUrl, path), {
      method,
      headers: {
        authorization: `Bearer ${this.#o.workerSecret}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.#o.requestTimeoutMs),
    });
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = (await res.json()) as { error?: unknown };
        if (typeof parsed?.error === 'string') detail = `: ${parsed.error}`;
      } catch {
        // no JSON body
      }
      throw new RelayHttpError(res.status, `${method} ${path} failed with ${res.status}${detail}`);
    }
    return res;
  }

  // ---- WebSocket ------------------------------------------------------------

  #connect(): void {
    if (!this.#running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayUrl(this.#o.workerUrl, RelayRoutes.ws.path, 'ws'), {
        headers: { authorization: `Bearer ${this.#o.workerSecret}` },
        handshakeTimeout: this.#o.requestTimeoutMs,
      });
    } catch (err) {
      this.#log('relay socket could not be created', err);
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;
    let alive = true;

    ws.on('open', () => {
      this.#attempt = 0;
      this.#log('relay connected');
      clearInterval(this.#pingTimer);
      this.#pingTimer = setInterval(() => {
        if (!alive) {
          this.#log('relay socket stopped answering pings; reconnecting');
          ws.terminate();
          return;
        }
        alive = false;
        ws.ping();
      }, this.#o.pingIntervalMs);
      this.#pingTimer.unref?.();
    });
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('message', (data) => {
      alive = true;
      this.#receive(ws, data.toString());
    });
    ws.on('unexpected-response', (_req, res) => {
      this.#log(`relay socket refused with HTTP ${res.statusCode}`);
      ws.terminate();
    });
    ws.on('error', (err) => this.#log('relay socket error', err));
    ws.on('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = undefined;
      clearInterval(this.#pingTimer);
      this.#pingTimer = undefined;
      this.#scheduleReconnect();
    });
  }

  #receive(ws: WebSocket, raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.#log(`relay sent a non-JSON frame; ignored`);
      return;
    }
    const parsed = WorkerToPc.safeParse(json);
    if (!parsed.success) {
      this.#log(`relay sent an unknown frame; ignored: ${raw.slice(0, 200)}`);
      return;
    }
    const frame = parsed.data;
    this.#chain = this.#chain.then(async () => {
      if (!this.#running || !this.#onFrame) return;
      try {
        await this.#onFrame(frame);
      } catch (err) {
        this.#log(`relay frame ${frame.id} failed; left unacked for redelivery`, err);
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ack', ids: [frame.id] }));
    });
  }

  #scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer) return;
    const delay = backoffDelay(this.#attempt, this.#o.backoffMinMs, this.#o.backoffMaxMs);
    this.#attempt++;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#connect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  #closeSocket(): void {
    const ws = this.#ws;
    this.#ws = undefined;
    clearInterval(this.#pingTimer);
    this.#pingTimer = undefined;
    if (!ws) return;
    ws.removeAllListeners('close');
    ws.on('error', () => {});
    if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    else ws.close();
  }

  #log(message: string, err?: unknown): void {
    if (this.#o.log) this.#o.log(message, err);
    else if (err === undefined) console.info(`[clippy] ${message}`);
    else console.warn(`[clippy] ${message}:`, err instanceof Error ? err.message : err);
  }
}
