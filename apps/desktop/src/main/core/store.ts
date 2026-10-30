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
  /** Telegram message id of the copy in the paired chat. */
  tgMsgId?: number;
  /** Initial state; default `'unread'` (chat lines are stored straight into history as `'done'`). */
  state?: MessageState;
  /** For `kind: 'reminder'`: the Reminder that produced it (internal link, not part of the shared Message). */
  reminderId?: string;
}

/** Mutable message fields. `null` clears an optional field. */
export interface MessagePatch {
  state?: MessageState;
  doneAt?: number | null;
  snoozedUntil?: number | null;
  waId?: string | null;
  tgMsgId?: number | null;
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
  // 2: link fired reminder messages to their Reminder (relay reconciliation of Worker firings).
  `
  ALTER TABLE messages ADD COLUMN reminder_id TEXT;
  CREATE INDEX messages_reminder ON messages (reminder_id, created_at) WHERE reminder_id IS NOT NULL;
  `,
  // 3: Telegram message id of the mirrored copy (reply-to and button routing, answered edits).
  `
  ALTER TABLE messages ADD COLUMN tg_msg_id INTEGER;
  CREATE INDEX messages_tg_msg_id ON messages (tg_msg_id) WHERE tg_msg_id IS NOT NULL;
  `,
];

type Row = Record<string, SQLOutputValue>;

export class Store {
  readonly #db: DatabaseSync;
  readonly #bus: Bus | undefined;
  readonly #clock: Clock;
  readonly #ulid = monotonicFactory();
  /** Events held back while a {@link transaction} is open; emitted on commit, dropped on rollback. */
  #deferred: (() => void)[] | undefined;

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

  /**
   * Run `fn` in a transaction. Bus events from writes inside it are emitted
   * only after COMMIT (and dropped on ROLLBACK), so listeners never see a
   * message that was rolled back. Not reentrant.
   */
  transaction<T>(fn: () => T): T {
    if (this.#deferred) throw new Error('Store.transaction is not reentrant');
    const deferred: (() => void)[] = [];
    // BEGIN first: if it throws (e.g. the database is closed) nothing is left half-open.
    this.#db.exec('BEGIN');
    this.#deferred = deferred;
    let result: T;
    try {
      result = fn();
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    } finally {
      this.#deferred = undefined;
    }
    for (const emit of deferred) emit();
    return result;
  }

  // ---- messages -------------------------------------------------------------

  /** Store a new message (unread unless `record.state` says otherwise) and emit `message:new`. */
  createMessage(record: NewMessageRecord): Message {
    const id = this.newId();
    const createdAt = this.#clock.now();
    const state = record.state ?? 'unread';
    this.#db
      .prepare(
        `INSERT INTO messages (id, kind, body, title, sender, project, urgent, state, created_at, done_at, wa_id, tg_msg_id, options, role, missed, reminder_id)
         VALUES ($id, $kind, $body, $title, $sender, $project, $urgent, $state, $createdAt, $doneAt, $waId, $tgMsgId, $options, $role, $missed, $reminderId)`,
      )
      .run({
        id,
        kind: record.kind,
        state,
        body: record.body,
        title: record.title ?? null,
        sender: record.sender,
        project: record.project ?? null,
        urgent: record.urgent ? 1 : 0,
        createdAt,
        doneAt: state === 'done' ? createdAt : null,
        waId: record.waId ?? null,
        tgMsgId: record.tgMsgId ?? null,
        options: record.options ? JSON.stringify(record.options) : null,
        role: record.role ?? null,
        missed: record.missed === undefined ? null : record.missed ? 1 : 0,
        reminderId: record.reminderId ?? null,
      });
    const message = this.getMessage(id)!;
    this.#emit('message:new', message);
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

  /** The latest message whose Telegram copy is `tgMsgId` (for matching replies and button taps). */
  findMessageByTgMsgId(tgMsgId: number): Message | undefined {
    const row = this.#db
      .prepare('SELECT * FROM messages WHERE tg_msg_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1')
      .get(tgMsgId);
    return row && toMessage(row);
  }

  /** The most recent message fired for reminder `reminderId` (see {@link NewMessageRecord.reminderId}). */
  findLatestReminderMessage(reminderId: string): Message | undefined {
    const row = this.#db
      .prepare('SELECT * FROM messages WHERE reminder_id = ? ORDER BY created_at DESC, seq DESC LIMIT 1')
      .get(reminderId);
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
      tgMsgId: 'tg_msg_id',
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
    if (message) this.#emit('message:updated', message);
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

  /** A reminder with its recurrence anchor. */
  getScheduledReminder(id: string): ScheduledReminder | undefined {
    const row = this.#db.prepare('SELECT * FROM reminders WHERE id = ?').get(id);
    return row && { ...toReminder(row), startAt: Number(row.start_at) };
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

  #emit<E extends 'message:new' | 'message:updated'>(event: E, message: Message): void {
    const bus = this.#bus;
    if (!bus) return;
    if (this.#deferred) this.#deferred.push(() => bus.emit(event, message));
    else bus.emit(event, message);
  }

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
  if (row.tg_msg_id !== null && row.tg_msg_id !== undefined) message.tgMsgId = Number(row.tg_msg_id);
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
