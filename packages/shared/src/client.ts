/**
 * `ClippyClient`: typed fetch-based client for the desktop app's local API
 * (Node only). Used by the MCP server and the Claude Code hook.
 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { ApiError, Health, MAX_LONG_POLL_S, Routes, routePath, type RouteDef } from './api';
import { portPath, tokenPath } from './paths';
import {
  AskResult,
  Message,
  Reminder,
  type AnsweredVia,
  type MessageFilter,
  type NewAskInput,
  type NewMessageInput,
  type NewReminderInput,
} from './schemas';

/** Thrown when the desktop app isn't running: port/token files missing, or the API is unreachable. */
export class ClippyNotRunningError extends Error {
  override readonly name = 'ClippyNotRunningError';
  constructor(message = 'Professor Clippy is not running', options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Thrown when the API answers with a non-2xx status. */
export class ClippyApiError extends Error {
  override readonly name = 'ClippyApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Options for {@link ClippyClient}. */
export interface ClippyClientOptions {
  /** e.g. `http://127.0.0.1:51234` (no trailing slash needed). */
  baseUrl: string;
  /** Bearer token (contents of the `token` file). */
  token: string;
  /** Per-request timeout for ordinary calls, ms. Default 10 000. */
  timeoutMs?: number;
  /** Longest single long-poll in `waitAsk`, seconds. Default {@link MAX_LONG_POLL_S}. */
  longPollChunkS?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export class ClippyClient {
  readonly baseUrl: string;
  readonly #token: string;
  readonly #timeoutMs: number;
  readonly #longPollChunkS: number;

  constructor(options: ClippyClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#longPollChunkS = options.longPollChunkS ?? MAX_LONG_POLL_S;
  }

  /**
   * Build a client from the `port` and `token` files in the app data dir and
   * check the app answers `/health`. Throws {@link ClippyNotRunningError} if a
   * file is missing/invalid or the app is unreachable.
   */
  static async fromAppData(options: Pick<ClippyClientOptions, 'timeoutMs'> = {}): Promise<ClippyClient> {
    let port: string;
    let token: string;
    try {
      [port, token] = await Promise.all([
        readFile(portPath(), 'utf8').then((s) => s.trim()),
        readFile(tokenPath(), 'utf8').then((s) => s.trim()),
      ]);
    } catch (cause) {
      throw new ClippyNotRunningError('Professor Clippy is not running (no port/token file)', { cause });
    }
    if (!/^\d+$/.test(port) || !token) {
      throw new ClippyNotRunningError('Professor Clippy is not running (invalid port/token file)');
    }
    const client = new ClippyClient({ baseUrl: `http://127.0.0.1:${port}`, token, ...options });
    try {
      await client.health();
    } catch (cause) {
      if (cause instanceof ClippyNotRunningError) throw cause;
      throw new ClippyNotRunningError('Professor Clippy is not responding', { cause });
    }
    return client;
  }

  /** `GET /health`. */
  health(): Promise<Health> {
    return this.#request(Routes.health, { schema: Health });
  }

  /** `POST /messages`: leave a note on the sticky note. */
  postMessage(input: NewMessageInput): Promise<Message> {
    return this.#request(Routes.postMessage, { body: input, schema: Message });
  }

  /** `GET /messages`: list messages, optionally filtered by state/kind or FTS query `q`. */
  listMessages(filter: MessageFilter = {}): Promise<Message[]> {
    return this.#request(Routes.listMessages, { query: filter, schema: z.array(Message) });
  }

  /** `POST /messages/:id/done`: dismiss a message into history. */
  markDone(id: string): Promise<Message> {
    return this.#request(Routes.markDone, { id, schema: Message });
  }

  /** `POST /messages/:id/snooze`: hide a message until `until` (epoch ms). */
  snooze(id: string, until: number): Promise<Message> {
    return this.#request(Routes.snooze, { id, body: { until }, schema: Message });
  }

  /** `POST /reminders`: schedule a one-off or recurring reminder. */
  createReminder(input: NewReminderInput): Promise<Reminder> {
    return this.#request(Routes.createReminder, { body: input, schema: Reminder });
  }

  /** `GET /reminders`: active reminders. */
  listReminders(): Promise<Reminder[]> {
    return this.#request(Routes.listReminders, { schema: z.array(Reminder) });
  }

  /** `DELETE /reminders/:id`. */
  async cancelReminder(id: string): Promise<void> {
    await this.#request(Routes.cancelReminder, { id });
  }

  /** `POST /asks`: post a question; returns the `kind: 'ask'` Message (its `id` is the ask id). */
  createAsk(input: NewAskInput): Promise<Message> {
    return this.#request(Routes.createAsk, { body: input, schema: Message });
  }

  /**
   * Wait up to `waitSeconds` for an answer (`GET /asks/:id?wait=`), issuing
   * successive long-polls of at most `longPollChunkS` each. Returns as soon as
   * the ask is answered, else `{ status: 'pending', id }` when time runs out.
   */
  async waitAsk(id: string, waitSeconds: number): Promise<AskResult> {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    for (;;) {
      const remainingS = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      const wait = Math.min(remainingS, this.#longPollChunkS);
      const result = await this.#request(Routes.getAsk, {
        id,
        query: { wait: String(wait) },
        schema: AskResult,
        timeoutMs: wait * 1000 + this.#timeoutMs,
      });
      if (result.status === 'answered' || Date.now() >= deadline) return result;
    }
  }

  /** `POST /asks/:id/answer`. */
  answerAsk(id: string, answer: string, via: AnsweredVia): Promise<AskResult> {
    return this.#request(Routes.answerAsk, { id, body: { answer, via }, schema: AskResult });
  }

  /** `GET /asks/pending`: unanswered asks. */
  listPendingAsks(): Promise<Message[]> {
    return this.#request(Routes.listPendingAsks, { schema: z.array(Message) });
  }

  async #request<T = undefined>(
    route: RouteDef,
    opts: {
      id?: string;
      query?: Record<string, string | undefined>;
      body?: unknown;
      schema?: z.ZodType<T>;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = new URL(this.baseUrl + routePath(route, opts.id));
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.#token}`, accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';

    let res: Response;
    try {
      res = await fetch(url, {
        method: route.method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.#timeoutMs),
      });
    } catch (cause) {
      // Connection refused / reset / timeout: the app is gone or hung.
      throw new ClippyNotRunningError(`Professor Clippy is not reachable at ${this.baseUrl}`, { cause });
    }

    const text = await res.text();
    if (!res.ok) {
      let message = `${route.method} ${url.pathname} failed with ${res.status}`;
      const parsed = ApiError.safeParse(safeJson(text));
      if (parsed.success) message += `: ${parsed.data.error}`;
      throw new ClippyApiError(res.status, message);
    }
    if (!opts.schema) return undefined as T;
    return opts.schema.parse(safeJson(text));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
