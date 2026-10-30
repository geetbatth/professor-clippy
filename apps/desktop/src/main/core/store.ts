/**
 * SQLite persistence (built-in `node:sqlite`): messages (+ FTS5 history search),
 * reminders and a small key/value table.
 *
 * Message writes emit `message:new` / `message:updated` on the bus, so every
 * caller (local API, IPC backend, scheduler, relay) produces the same events.
 */
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';
import type {
  AnsweredVia,
  ChatRole,
  Message,
  MessageFilter,
  MessageKind,
  MessageState,
  Reminder,
} from '@clippy/shared';
import { monotonicFactory } from 'ulid';
import type { Bus } from './bus';
import { systemClock, type Clock } from './clock';

/** Fields a caller supplies to create a message; id, createdAt and state are filled in. */
export interface NewMessageRecord {
  kind: MessageKind;
  body: string;
  sender: string;
  title?: string;
  project?: string;
  urgent?: boolean;
  options?: string[];
  role?: ChatRole;
  missed?: boolean;
  waId?: string;
}

/** Mutable message fields. `null` clears an optional field. */
export interface MessagePatch {
  state?: MessageState;
  doneAt?: number | null;
  snoozedUntil?: number | null;
  waId?: string | null;
  answer?: string;
  answeredVia?: AnsweredVia;
}

/** A reminder plus the internal recurrence anchor (RRULE DTSTART = the original `when`). */
export interface ScheduledReminder extends Reminder {
  startAt: number;
}

/** Mutable reminder fields. */
export interface ReminderPatch {
  dueAt?: number;
  active?: boolean;
  lastFiredAt?: number;
}

export interface StoreOptions {
  /** SQLite file path, or `':memory:'`. */
  path: string;
  bus?: Bus;
  clock?: Clock;
}

/** Schema migrations; `PRAGMA user_version` = number applied. Append only. */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY,            -- stable rowid for the FTS index (survives VACUUM)
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    title TEXT,
    sender TEXT NOT NULL,
    project TEXT,
    urgent INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    done_at INTEGER,
    snoozed_until INTEGER,
    wa_id TEXT,
    options TEXT,                       -- JSON array
    answer TEXT,
    answered_via TEXT,
    role TEXT,
    missed INTEGER
  );
  CREATE INDEX messages_created ON messages (created_at);
  CREATE INDEX messages_snoozed ON messages (snoozed_until) WHERE state = 'snoozed';
  CREATE INDEX messages_wa_id ON messages (wa_id) WHERE wa_id IS NOT NULL;

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    title, body, content = 'messages', content_rowid = 'seq', tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, title, body) VALUES (new.seq, new.title, new.body);
  END;
  CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
  END;
  CREATE TRIGGER messages_fts_au AFTER UPDATE OF title, body ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, title, body) VALUES ('delete', old.seq, old.title, old.body);
    INSERT INTO messages_fts (rowid, title, body) VALUES (new.seq, new.title, new.body);
  END;

  CREATE TABLE reminders (
    id TEXT PRIMARY KEY,
    body TEXT NOT NULL,
    sender TEXT NOT NULL,
    project TEXT,
    start_at INTEGER NOT NULL,
    due_at INTEGER NOT NULL,
    rrule TEXT,
    active INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_fired_at INTEGER
  );
  CREATE INDEX reminders_due ON reminders (due_at) WHERE active = 1;

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

type Row = Record<string, SQLOutputValue>;

export class Store {
  readonly #db: DatabaseSync;
  readonly #bus: Bus | undefined;
  readonly #clock: Clock;
  readonly #ulid = monotonicFactory();

  constructor(options: StoreOptions) {
    this.#bus = options.bus;
    this.#clock = options.clock ?? systemClock;
    this.#db = new DatabaseSync(options.path);
    this.#db.exec('PRAGMA busy_timeout = 5000');
    if (options.path !== ':memory:') this.#db.exec('PRAGMA journal_mode = WAL');
    this.#migrate();
  }

  /** Schema version (number of migrations applied). */
  get schemaVersion(): number {
    return Number(this.#db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  /** New ULID whose time part is the injected clock's now. */
  newId(): string {
    return this.#ulid(this.#clock.now());
  }

  // ---- messages -------------------------------------------------------------

  /** Store a new unread message and emit `message:new`. */
  createMessage(record: NewMessageRecord): Message {
    const id = this.newId();
    this.#db
      .prepare(
        `INSERT INTO messages (id, kind, body, title, sender, project, urgent, state, created_at, wa_id, options, role, missed)
         VALUES ($id, $kind, $body, $title, $sender, $project, $urgent, 'unread', $createdAt, $waId, $options, $role, $missed)`,
      )
      .run({
        id,
        kind: record.kind,
        body: record.body,
        title: record.title ?? null,
        sender: record.sender,
        project: record.project ?? null,
        urgent: record.urgent ? 1 : 0,
        createdAt: this.#clock.now(),
        waId: record.waId ?? null,
        options: record.options ? JSON.stringify(record.options) : null,
        role: record.role ?? null,
        missed: record.missed === undefined ? null : record.missed ? 1 : 0,
      });
    const message = this.getMessage(id)!;
    this.#bus?.emit('message:new', message);
    return message;
  }

  getMessage(id: string): Message | undefined {
    const row = this.#db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    return row && toMessage(row);
  }

  /** The message mirrored to WhatsApp as `waId` (for matching quote-replies). */
  findMessageByWaId(waId: string): Message | undefined {
    const row = this.#db.prepare('SELECT * FROM messages WHERE wa_id = ?').get(waId);
    return row && toMessage(row);
  }

  /**
   * Messages matching `filter`, newest first. `q` is a full-text search over
   * title and body: every word must match, as a prefix (`deploy` finds
   * "deployment"). FTS syntax characters in `q` are ignored, never an error.
   */
  listMessages(filter: MessageFilter = {}): Message[] {
    const where: string[] = [];
    const params: Record<string, SQLInputValue> = {};
    if (filter.state) {
      where.push('m.state = $state');
      params.state = filter.state;
    }
    if (filter.kind) {
      where.push('m.kind = $kind');
      params.kind = filter.kind;
    }
    let from = 'messages m';
    if (filter.q !== undefined && filter.q.trim() !== '') {
      const match = toFtsQuery(filter.q);
      if (match === undefined) return [];
      from = 'messages_fts f JOIN messages m ON m.seq = f.rowid';
      where.push('messages_fts MATCH $match');
      params.match = match;
    }
    const sql = `SELECT m.* FROM ${from} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY m.created_at DESC, m.seq DESC`;
    return this.#db.prepare(sql).all(params).map(toMessage);
  }

  /** Unanswered asks, newest first. */
  listPendingAsks(): Message[] {
    return this.#db
      .prepare(`SELECT * FROM messages WHERE kind = 'ask' AND answer IS NULL ORDER BY created_at DESC, seq DESC`)
      .all()
      .map(toMessage);
  }

  /** Apply `patch` and emit `message:updated`. Returns undefined for an unknown id. */
  updateMessage(id: string, patch: MessagePatch): Message | undefined {
    const columns: Record<keyof MessagePatch, string> = {
      state: 'state',
      doneAt: 'done_at',
      snoozedUntil: 'snoozed_until',
      waId: 'wa_id',
      answer: 'answer',
      answeredVia: 'answered_via',
    };
    const sets: string[] = [];
    const params: Record<string, SQLInputValue> = { id };
    for (const key of Object.keys(columns) as (keyof MessagePatch)[]) {
      if (patch[key] === undefined) continue;
      sets.push(`${columns[key]} = $${key}`);
      params[key] = patch[key];
    }
    if (sets.length > 0) {
      this.#db.prepare(`UPDATE messages SET ${sets.join(', ')} WHERE id = $id`).run(params);
    }
    const message = this.getMessage(id);
    if (message) this.#bus?.emit('message:updated', message);
    return message;
  }

  /** Dismiss into history. */
  markDone(id: string): Message | undefined {
    return this.updateMessage(id, { state: 'done', doneAt: this.#clock.now(), snoozedUntil: null });
  }

  /** Hide until `until` (epoch ms); the scheduler wakes it back to unread. */
  snooze(id: string, until: number): Message | undefined {
    return this.updateMessage(id, { state: 'snoozed', snoozedUntil: until, doneAt: null });
  }

  /** Snoozed messages whose snooze has expired at `now`. */
  listExpiredSnoozes(now: number): Message[] {
    return this.#db
      .prepare(`SELECT * FROM messages WHERE state = 'snoozed' AND snoozed_until <= ? ORDER BY snoozed_until`)
      .all(now)
      .map(toMessage);
  }

  /** Earliest pending snooze wake-up time, if any. */
  nextSnoozeWake(): number | undefined {
    const row = this.#db.prepare(`SELECT MIN(snoozed_until) AS t FROM messages WHERE state = 'snoozed'`).get();
    return optNumber(row?.t);
  }

  // ---- reminders ------------------------------------------------------------

  insertReminder(reminder: ScheduledReminder): void {
    this.#db
      .prepare(
        `INSERT INTO reminders (id, body, sender, project, start_at, due_at, rrule, active, created_at, last_fired_at)
         VALUES ($id, $body, $sender, $project, $startAt, $dueAt, $rrule, $active, $createdAt, $lastFiredAt)`,
      )
      .run({
        id: reminder.id,
        body: reminder.body,
        sender: reminder.sender,
        project: reminder.project ?? null,
        startAt: reminder.startAt,
        dueAt: reminder.dueAt,
        rrule: reminder.rrule ?? null,
        active: reminder.active ? 1 : 0,
        createdAt: reminder.createdAt,
        lastFiredAt: reminder.lastFiredAt ?? null,
      });
  }

  getReminder(id: string): Reminder | undefined {
    const row = this.#db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    return row && toReminder(row);
  }

  /** Active reminders, soonest first. */
  listActiveReminders(): Reminder[] {
    return this.#db
      .prepare('SELECT * FROM reminders WHERE active = 1 ORDER BY due_at, id')
      .all()
      .map(toReminder);
  }

  /** Active reminders due at or before `now`, oldest due first, with their recurrence anchor. */
  listDueReminders(now: number): ScheduledReminder[] {
    return this.#db
      .prepare('SELECT * FROM reminders WHERE active = 1 AND due_at <= ? ORDER BY due_at, id')
      .all(now)
      .map((row) => ({ ...toReminder(row), startAt: Number(row.start_at) }));
  }

  /** Earliest active reminder due time, if any. */
  nextReminderDue(): number | undefined {
    const row = this.#db.prepare('SELECT MIN(due_at) AS t FROM reminders WHERE active = 1').get();
    return optNumber(row?.t);
  }

  updateReminder(id: string, patch: ReminderPatch): Reminder | undefined {
    const sets: string[] = [];
    const params: Record<string, SQLInputValue> = { id };
    if (patch.dueAt !== undefined) {
      sets.push('due_at = $dueAt');
      params.dueAt = patch.dueAt;
    }
    if (patch.active !== undefined) {
      sets.push('active = $active');
      params.active = patch.active ? 1 : 0;
    }
    if (patch.lastFiredAt !== undefined) {
      sets.push('last_fired_at = $lastFiredAt');
      params.lastFiredAt = patch.lastFiredAt;
    }
    if (sets.length > 0) this.#db.prepare(`UPDATE reminders SET ${sets.join(', ')} WHERE id = $id`).run(params);
    return this.getReminder(id);
  }

  // ---- kv -------------------------------------------------------------------

  getKv(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
    return row === undefined ? undefined : String(row.value);
  }

  setKv(key: string, value: string): void {
    this.#db
      .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, value);
  }

  deleteKv(key: string): void {
    this.#db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  }

  // ---- internals ------------------------------------------------------------

  #migrate(): void {
    for (let version = this.schemaVersion; version < MIGRATIONS.length; version++) {
      this.#db.exec('BEGIN');
      try {
        this.#db.exec(MIGRATIONS[version]!);
        this.#db.exec(`PRAGMA user_version = ${version + 1}`);
        this.#db.exec('COMMIT');
      } catch (err) {
        this.#db.exec('ROLLBACK');
        throw err;
      }
    }
  }
}

/**
 * Turn free text into a safe FTS5 query: each word becomes a quoted prefix
 * term, implicitly ANDed. Returns undefined when `q` has no searchable words.
 */
export function toFtsQuery(q: string): string | undefined {
  const words = q.match(/[\p{L}\p{N}_]+/gu);
  if (!words) return undefined;
  return words.map((w) => `"${w}"*`).join(' ');
}

function toMessage(row: Row): Message {
  const message: Message = {
    id: String(row.id),
    kind: String(row.kind) as MessageKind,
    body: String(row.body),
    sender: String(row.sender),
    urgent: row.urgent === 1,
    state: String(row.state) as MessageState,
    createdAt: Number(row.created_at),
  };
  if (row.title !== null) message.title = String(row.title);
  if (row.project !== null) message.project = String(row.project);
  if (row.done_at !== null) message.doneAt = Number(row.done_at);
  if (row.snoozed_until !== null) message.snoozedUntil = Number(row.snoozed_until);
  if (row.wa_id !== null) message.waId = String(row.wa_id);
  if (row.options !== null) message.options = JSON.parse(String(row.options)) as string[];
  if (row.answer !== null) message.answer = String(row.answer);
  if (row.answered_via !== null) message.answeredVia = String(row.answered_via) as AnsweredVia;
  if (row.role !== null) message.role = String(row.role) as ChatRole;
  if (row.missed !== null) message.missed = row.missed === 1;
  return message;
}

function toReminder(row: Row): Reminder {
  const reminder: Reminder = {
    id: String(row.id),
    body: String(row.body),
    sender: String(row.sender),
    dueAt: Number(row.due_at),
    active: row.active === 1,
    createdAt: Number(row.created_at),
  };
  if (row.project !== null) reminder.project = String(row.project);
  if (row.rrule !== null) reminder.rrule = String(row.rrule);
  if (row.last_fired_at !== null) reminder.lastFiredAt = Number(row.last_fired_at);
  return reminder;
}

function optNumber(value: SQLOutputValue | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}
