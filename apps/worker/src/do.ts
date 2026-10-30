/**
 * ClippyDO: the single relay Durable Object (SQLite storage). It holds
 * - `outbox`: Worker→PC frames not yet acked (inbound texts and reminder firings),
 * - `reminders`: synced reminders, fired by the DO alarm while the PC may be off,
 * - `kv`: `lastInboundAt` (start of the 24 h window),
 * - `sent`: wamid → kind of every message we sent (kept 30 days),
 * - `seen`: inbound wamids already queued (kept 7 days), so Meta retries are not redelivered.
 * Every connected PC socket (hibernation API) gets each new frame; on connect all
 * unacked frames are replayed in order.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  PcToWorker,
  type RelayInbound,
  type RelayReminderFired,
  type RelayReminderPut,
  type RelaySendRequest,
  type RelaySendResponse,
  type WorkerToPc,
} from '@clippy/shared/relay';
import type { Env } from './index';
import { nextOccurrence } from './recurrence';
import type { InboundText } from './webhook';
import { sendWhatsApp } from './whatsapp';

/** Prefix on reminder notifications sent to WhatsApp. */
export const REMINDER_PREFIX = '⏰ ';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEEN_TTL_MS = 7 * DAY_MS;
const SENT_TTL_MS = 30 * DAY_MS;

interface ReminderRow extends Record<string, SqlStorageValue> {
  id: string;
  body: string;
  due_at: number;
  rrule: string | null;
  dtstart: number;
}

export class ClippyDO extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS outbox (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        frame TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        due_at INTEGER NOT NULL,
        rrule TEXT,
        dtstart INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sent (wa_id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS seen (wa_id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    `);
  }

  // ---------------------------------------------------------------- state

  lastInboundAt(): number | undefined {
    const row = this.sql.exec<{ value: number }>(`SELECT value FROM kv WHERE key = 'lastInboundAt'`).toArray()[0];
    return row?.value;
  }

  /** Unacked frames in delivery order. */
  pending(): WorkerToPc[] {
    return this.sql
      .exec<{ frame: string }>('SELECT frame FROM outbox ORDER BY seq')
      .toArray()
      .map((r) => JSON.parse(r.frame) as WorkerToPc);
  }

  // ---------------------------------------------------------------- inbound

  /** Queue the user's WhatsApp texts for the PC and move the 24 h window. */
  ingestInbound(items: InboundText[]): void {
    const now = Date.now();
    this.sql.exec('DELETE FROM seen WHERE at < ?', now - SEEN_TTL_MS);
    for (const item of items) {
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('lastInboundAt', ?)
         ON CONFLICT(key) DO UPDATE SET value = max(value, excluded.value)`,
        item.ts,
      );
      const fresh = this.sql.exec('INSERT OR IGNORE INTO seen (wa_id, at) VALUES (?, ?)', item.id, now).rowsWritten;
      if (fresh === 0) continue; // Meta redelivered a webhook we already queued
      const frame: RelayInbound = {
        type: 'inbound',
        id: item.id,
        text: item.text,
        ...(item.contextWaId !== undefined ? { contextWaId: item.contextWaId } : {}),
        ts: item.ts,
      };
      this.enqueue(frame);
    }
  }

  // ---------------------------------------------------------------- sending

  /** Mirror one message to WhatsApp. Any send failure (Meta refusal or network) comes back as `{error}`. */
  async send(req: RelaySendRequest): Promise<RelaySendResponse | { error: string }> {
    try {
      return await this.deliver(req.text, req.kind);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async deliver(text: string, kind: string): Promise<RelaySendResponse> {
    const now = Date.now();
    const result = await sendWhatsApp(this.env, text, now, this.lastInboundAt());
    this.sql.exec('DELETE FROM sent WHERE at < ?', now - SENT_TTL_MS);
    this.sql.exec('INSERT OR REPLACE INTO sent (wa_id, kind, at) VALUES (?, ?, ?)', result.waId, kind, now);
    return result;
  }

  // ---------------------------------------------------------------- reminders

  /** Create or replace a reminder. `dueAt` also becomes the RRULE's DTSTART anchor. */
  async putReminder(id: string, put: RelayReminderPut): Promise<void> {
    this.sql.exec(
      'INSERT OR REPLACE INTO reminders (id, body, due_at, rrule, dtstart) VALUES (?, ?, ?, ?, ?)',
      id,
      put.body,
      put.dueAt,
      put.rrule ?? null,
      put.dueAt,
    );
    await this.rearm();
  }

  async deleteReminder(id: string): Promise<void> {
    this.sql.exec('DELETE FROM reminders WHERE id = ?', id);
    await this.rearm();
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    const due = this.sql
      .exec<ReminderRow>('SELECT * FROM reminders WHERE due_at <= ? ORDER BY due_at', now)
      .toArray();
    for (const r of due) {
      let waId: string | undefined;
      try {
        waId = (await this.deliver(REMINDER_PREFIX + r.body, 'reminder')).waId;
      } catch (err) {
        // Still record the firing: the PC shows it, and one bad send must not block the rest.
        console.error(`reminder ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      const firedAt = Date.now();
      // A PUT/DELETE may have run while we awaited Meta; only advance the row we fired.
      const current = this.sql
        .exec<ReminderRow>('SELECT * FROM reminders WHERE id = ?', r.id)
        .toArray()[0];
      if (current && current.due_at === r.due_at && current.rrule === r.rrule) {
        const next = r.rrule ? safeNext(r, now) : undefined; // skips occurrences missed while overdue
        if (next === undefined) this.sql.exec('DELETE FROM reminders WHERE id = ?', r.id);
        else this.sql.exec('UPDATE reminders SET due_at = ? WHERE id = ?', next, r.id);
      }
      const nextDueAt = this.sql
        .exec<{ due_at: number }>('SELECT due_at FROM reminders WHERE id = ?', r.id)
        .toArray()[0]?.due_at;
      const frame: RelayReminderFired = {
        type: 'reminder-fired',
        id: r.id,
        firedAt,
        ...(waId !== undefined ? { waId } : {}),
        ...(nextDueAt !== undefined ? { nextDueAt } : {}),
      };
      this.enqueue(frame);
    }
    await this.rearm();
  }

  /** Alarm at the earliest due reminder, or none. */
  private async rearm(): Promise<void> {
    const row = this.sql.exec<{ next: number | null }>('SELECT min(due_at) AS next FROM reminders').one();
    if (row.next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(row.next);
  }

  // ---------------------------------------------------------------- PC socket

  /** Store a frame until acked (one per id: a newer reminder firing replaces the older) and push it. */
  private enqueue(frame: WorkerToPc): void {
    const json = JSON.stringify(frame);
    const verb = frame.type === 'reminder-fired' ? 'INSERT OR REPLACE' : 'INSERT OR IGNORE';
    this.sql.exec(`${verb} INTO outbox (id, frame) VALUES (?, ?)`, frame.id, json);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        // Socket is closing; the frame stays queued for the next connect.
      }
    }
  }

  /** `GET /ws` (already authenticated by the Worker): accept and replay unacked frames. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    for (const row of this.sql.exec<{ frame: string }>('SELECT frame FROM outbox ORDER BY seq')) {
      server.send(row.frame);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }
    const parsed = PcToWorker.safeParse(data);
    if (!parsed.success) return;
    for (const id of parsed.data.ids) this.sql.exec('DELETE FROM outbox WHERE id = ?', id);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
  }
}

/** Next occurrence, or undefined (finish the reminder) if the stored rule no longer parses. */
function safeNext(r: ReminderRow, after: number): number | undefined {
  try {
    return nextOccurrence(r.rrule ?? '', r.dtstart, after);
  } catch (err) {
    console.error(`reminder ${r.id}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}
