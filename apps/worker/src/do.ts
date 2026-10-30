/**
 * ClippyDO: the single relay Durable Object (SQLite storage). It holds
 * - `outbox`: Worker→PC frames not yet acked (inbound texts and reminder firings),
 * - `reminders`: synced reminders, fired by the DO alarm while the PC may be off,
 * - `kv`: `lastInboundAt` (start of the 24 h window),
 * - `sent`: wamid → kind of every message we sent (kept 30 days),
 * - `seen`: inbound wamids already handled (kept 7 days), so Meta retries are not redelivered.
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
import type { InboundMessage } from './webhook';
import { isTransientSendError, sendWhatsApp } from './whatsapp';

/** Prefix on reminder notifications sent to WhatsApp. */
export const REMINDER_PREFIX = '⏰ ';

/**
 * Delay before each retry of a reminder whose WhatsApp send failed transiently
 * (1, 4, 10, 15 min: 5 attempts over ~30 min). After the last one the firing is
 * recorded without a `waId`.
 */
export const REMINDER_RETRY_DELAYS_MS = [1, 4, 10, 15].map((m) => m * 60_000);
export const REMINDER_MAX_ATTEMPTS = REMINDER_RETRY_DELAYS_MS.length + 1;

const DAY_MS = 24 * 60 * 60 * 1000;
const SEEN_TTL_MS = 7 * DAY_MS;
const SENT_TTL_MS = 30 * DAY_MS;

interface ReminderRow extends Record<string, SqlStorageValue> {
  id: string;
  body: string;
  /** The occurrence being delivered (or the next one). */
  due_at: number;
  rrule: string | null;
  /** IANA zone the RRULE runs in; null = UTC. */
  tz: string | null;
  /** RRULE anchor: the PUT's `startAt` (the PC's original start), else its `dueAt`. */
  dtstart: number;
  /** Failed send attempts for the occurrence at `due_at`. */
  attempts: number;
  /** When to retry the send, while retrying; else null. */
  retry_at: number | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
        tz TEXT,
        dtstart INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER
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

  /** Move the 24 h window for every user message; queue the text ones for the PC. */
  ingestInbound(items: InboundMessage[]): void {
    const now = Date.now();
    this.sql.exec('DELETE FROM seen WHERE at < ?', now - SEEN_TTL_MS);
    for (const item of items) {
      this.sql.exec(
        `INSERT INTO kv (key, value) VALUES ('lastInboundAt', ?)
         ON CONFLICT(key) DO UPDATE SET value = max(value, excluded.value)`,
        item.ts,
      );
      const fresh = this.sql.exec('INSERT OR IGNORE INTO seen (wa_id, at) VALUES (?, ?)', item.id, now).rowsWritten;
      if (fresh === 0 || item.text === undefined) continue; // Meta retry, or not a text message
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
      return { error: message(err) };
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

  private reminder(id: string): ReminderRow | undefined {
    return this.sql.exec<ReminderRow>('SELECT * FROM reminders WHERE id = ?', id).toArray()[0];
  }

  /**
   * Create or replace a reminder; `startAt` (else `dueAt`) becomes the RRULE anchor, so COUNT
   * counts from the same start as on the PC. Exception: a
   * re-PUT of an existing recurring reminder with the same rule and tz and a `dueAt`
   * already in the past is the PC re-syncing an occurrence the Worker has handled
   * (or is handling), so only the body is updated and the Worker's schedule is kept.
   */
  async putReminder(id: string, put: RelayReminderPut): Promise<void> {
    const existing = this.reminder(id);
    const rrule = put.rrule ?? null;
    const tz = put.tz ?? null;
    if (existing && rrule !== null && existing.rrule === rrule && existing.tz === tz && put.dueAt <= Date.now()) {
      this.sql.exec('UPDATE reminders SET body = ? WHERE id = ?', put.body, id);
    } else {
      this.sql.exec(
        `INSERT OR REPLACE INTO reminders (id, body, due_at, rrule, tz, dtstart, attempts, retry_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, NULL)`,
        id,
        put.body,
        put.dueAt,
        rrule,
        tz,
        rrule !== null ? (put.startAt ?? put.dueAt) : put.dueAt,
      );
    }
    await this.rearm();
  }

  async deleteReminder(id: string): Promise<void> {
    this.sql.exec('DELETE FROM reminders WHERE id = ?', id);
    await this.rearm();
  }

  override async alarm(): Promise<void> {
    const now = Date.now();
    try {
      const due = this.sql
        .exec<ReminderRow>('SELECT * FROM reminders WHERE coalesce(retry_at, due_at) <= ? ORDER BY due_at', now)
        .toArray();
      for (const r of due) await this.fire(r, now);
    } finally {
      await this.rearm();
    }
  }

  /** True if `r` is still the stored row (no PUT/DELETE ran while we awaited Meta). */
  private unchanged(r: ReminderRow): boolean {
    const c = this.reminder(r.id);
    return (
      c !== undefined &&
      c.due_at === r.due_at &&
      c.rrule === r.rrule &&
      c.tz === r.tz &&
      c.dtstart === r.dtstart &&
      c.attempts === r.attempts
    );
  }

  /** Send one due reminder, then advance it or schedule a retry. */
  private async fire(r: ReminderRow, now: number): Promise<void> {
    let waId: string | undefined;
    try {
      waId = (await this.deliver(REMINDER_PREFIX + r.body, 'reminder')).waId;
    } catch (err) {
      const attempts = r.attempts + 1;
      if (isTransientSendError(err) && attempts < REMINDER_MAX_ATTEMPTS) {
        const delay = REMINDER_RETRY_DELAYS_MS[attempts - 1]!;
        if (this.unchanged(r)) {
          this.sql.exec(
            'UPDATE reminders SET attempts = ?, retry_at = ? WHERE id = ?',
            attempts,
            Date.now() + delay,
            r.id,
          );
        }
        console.warn(
          `reminder ${r.id}: send attempt ${attempts}/${REMINDER_MAX_ATTEMPTS} failed, retrying in ${delay / 60_000} min: ${message(err)}`,
        );
        return;
      }
      // Permanent error or out of retries: record the firing without a waId so the PC still shows it.
      console.error(`reminder ${r.id}: giving up after ${attempts} attempt(s): ${message(err)}`);
    }
    const firedAt = Date.now();
    if (this.unchanged(r)) {
      const next = r.rrule ? this.safeNext(r, now) : undefined; // skips occurrences missed while overdue
      if (next === undefined) this.sql.exec('DELETE FROM reminders WHERE id = ?', r.id);
      else this.sql.exec('UPDATE reminders SET due_at = ?, attempts = 0, retry_at = NULL WHERE id = ?', next, r.id);
    }
    const nextDueAt = this.reminder(r.id)?.due_at;
    const frame: RelayReminderFired = {
      type: 'reminder-fired',
      id: `${r.id}:${firedAt}`,
      reminderId: r.id,
      firedAt,
      ...(waId !== undefined ? { waId } : {}),
      ...(nextDueAt !== undefined ? { nextDueAt } : {}),
    };
    this.enqueue(frame);
  }

  /** Next occurrence after `after`, or undefined (finish the reminder) if the stored rule no longer works. */
  private safeNext(r: ReminderRow, after: number): number | undefined {
    try {
      return nextOccurrence(r.rrule ?? '', r.dtstart, after, r.tz ?? undefined);
    } catch (err) {
      console.error(`reminder ${r.id}: ${message(err)}`);
      return undefined;
    }
  }

  /** Alarm at the earliest due reminder or pending retry, or none. */
  private async rearm(): Promise<void> {
    const row = this.sql
      .exec<{ next: number | null }>('SELECT min(coalesce(retry_at, due_at)) AS next FROM reminders')
      .one();
    if (row.next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(row.next);
  }

  // ---------------------------------------------------------------- PC socket

  /** Store a frame until acked (ids are unique per delivery) and push it to every PC socket. */
  private enqueue(frame: WorkerToPc): void {
    const json = JSON.stringify(frame);
    this.sql.exec('INSERT OR IGNORE INTO outbox (id, frame) VALUES (?, ?)', frame.id, json);
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

  override async webSocketMessage(_ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    if (typeof msg !== 'string') return;
    let data: unknown;
    try {
      data = JSON.parse(msg);
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
