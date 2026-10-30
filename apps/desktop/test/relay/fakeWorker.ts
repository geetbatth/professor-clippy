/**
 * A fake relay Worker for tests: the REST routes plus `/ws` with the real Worker's outbox
 * semantics (every unacked frame is replayed on each connect, acks remove them).
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WorkerToPc } from '@clippy/shared';

export interface RecordedRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export class FakeWorker {
  readonly secret = 'test-secret';
  readonly requests: RecordedRequest[] = [];
  readonly acks: string[] = [];
  /** Frames not yet acked, in order. */
  outbox: WorkerToPc[] = [];
  connections = 0;
  rejectedUpgrades = 0;
  /** Respond to the next `/send` calls with these statuses (then 200). */
  sendFailures: number[] = [];
  #server: Server;
  #wss: WebSocketServer;
  #sockets = new Set<WebSocket>();
  #nextWa = 1;
  url = '';

  /** `autoPong: false` simulates a half-dead connection that never answers pings. */
  constructor(options: { autoPong?: boolean } = {}) {
    this.#wss = new WebSocketServer({ noServer: true, autoPong: options.autoPong ?? true });
    this.#server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      this.requests.push({ method: req.method ?? '', path, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
      if (req.headers.authorization !== `Bearer ${this.secret}`) return void res.writeHead(401).end('{"error":"unauthorized"}');
      if (req.method === 'POST' && path === '/send') {
        const status = this.sendFailures.shift();
        if (status) return void res.writeHead(status, { 'content-type': 'application/json' }).end('{"error":"meta said no"}');
        return void res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ waId: `wamid.${this.#nextWa++}`, mode: 'freeform' }));
      }
      if ((req.method === 'PUT' || req.method === 'DELETE') && path.startsWith('/reminders/')) return void res.writeHead(204).end();
      res.writeHead(404).end('{"error":"not found"}');
    });
    this.#server.on('upgrade', (req: IncomingMessage, socket, head) => {
      if (req.url !== '/ws' || req.headers.authorization !== `Bearer ${this.secret}`) {
        this.rejectedUpgrades++;
        socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#accept(ws));
    });
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  #accept(ws: WebSocket): void {
    this.connections++;
    this.#sockets.add(ws);
    ws.on('close', () => this.#sockets.delete(ws));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as { type: string; ids: string[] };
      if (msg.type !== 'ack') return;
      this.acks.push(...msg.ids);
      this.outbox = this.outbox.filter((f) => !msg.ids.includes(f.id));
    });
    for (const frame of this.outbox) ws.send(JSON.stringify(frame));
  }

  /** Queue a frame and push it to every connected socket. */
  push(frame: WorkerToPc): void {
    this.outbox.push(frame);
    for (const ws of this.#sockets) ws.send(JSON.stringify(frame));
  }

  /** Send raw text to every socket (malformed-frame tests). */
  pushRaw(text: string): void {
    for (const ws of this.#sockets) ws.send(text);
  }

  get openSockets(): number {
    return this.#sockets.size;
  }

  /** Drop every connection (the client should reconnect). */
  dropAll(): void {
    for (const ws of this.#sockets) ws.terminate();
  }

  async close(): Promise<void> {
    this.dropAll();
    this.#wss.close();
    this.#server.closeAllConnections();
    await new Promise<void>((r) => this.#server.close(() => r()));
  }
}

export async function waitFor(cond: () => boolean, timeoutMs = 3000, what = 'condition'): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
