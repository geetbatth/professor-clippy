/**
 * A small Telegram Bot API client over `fetch` (no dependencies). Outbound only: the app
 * long-polls `getUpdates`; nothing listens for a webhook.
 *
 * The token is part of every URL (`<base>/bot<token>/<method>`), so it is redacted from
 * every error this module raises: callers can log errors as they are.
 */

export const TELEGRAM_API_BASE = 'https://api.telegram.org';
/** Ordinary calls give up after this. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** Extra time a long-poll may take beyond its `timeout`. */
const LONG_POLL_GRACE_MS = 15_000;

// ---- the parts of Telegram's types Clippy uses ----------------------------

export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  username?: string;
}

export interface TgChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel' | string;
  first_name?: string;
  title?: string;
}

export interface TgMessage {
  message_id: number;
  date?: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageParams {
  chat_id: number;
  text: string;
  parse_mode?: 'HTML';
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  link_preview_options?: { is_disabled: boolean };
}

export interface EditMessageTextParams {
  chat_id: number;
  message_id: number;
  text: string;
  parse_mode?: 'HTML';
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  link_preview_options?: { is_disabled: boolean };
}

// ---- errors ---------------------------------------------------------------

/** Remove a bot token (and anything shaped like `/bot<token>/`) from `text`. */
export function redactToken(text: string, token?: string): string {
  let out = text;
  if (token) out = out.split(token).join('<token>');
  return out.replace(/\/bot[^/\s?#]+/g, '/bot<token>').replace(/\b\d{3,}:[A-Za-z0-9_-]{20,}\b/g, '<token>');
}

/** Telegram answered with an error (`ok: false` or a non-2xx status). */
export class TelegramApiError extends Error {
  constructor(
    readonly method: string,
    readonly status: number,
    readonly description: string,
    /** Seconds to wait, from a 429's `parameters.retry_after`. */
    readonly retryAfterS?: number,
  ) {
    super(`Telegram ${method} failed (${status}): ${description}`);
    this.name = 'TelegramApiError';
  }

  /** 4xx other than 408/429 won't succeed on retry. */
  get permanent(): boolean {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

/** The request never got an answer (offline, DNS, timeout). Its message has no URL in it. */
export class TelegramNetworkError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`Telegram ${method}: ${message}`);
    this.name = 'TelegramNetworkError';
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

// ---- client ---------------------------------------------------------------

export interface TelegramApiOptions {
  token: string;
  /** Default {@link TELEGRAM_API_BASE}; tests point it at a fake server. */
  baseUrl?: string;
  /** Default: the global `fetch` at call time (so test guards apply). */
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class TelegramApi {
  readonly #token: string;
  readonly #base: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #timeoutMs: number;

  constructor(options: TelegramApiOptions) {
    this.#token = options.token;
    this.#base = (options.baseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
    this.#fetch = options.fetch;
    this.#timeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** The bot's numeric id (the part of the token before `:`; not secret). */
  get botId(): string {
    return this.#token.split(':')[0] ?? 'bot';
  }

  getMe(signal?: AbortSignal): Promise<TgUser> {
    return this.call('getMe', undefined, { signal });
  }

  /** Long-poll: Telegram holds the request up to `timeoutS` seconds until updates arrive. */
  getUpdates(params: { offset?: number; timeoutS: number; allowedUpdates?: string[] }, signal?: AbortSignal): Promise<TgUpdate[]> {
    const query: Record<string, string> = { timeout: String(params.timeoutS) };
    if (params.offset !== undefined) query.offset = String(params.offset);
    if (params.allowedUpdates) query.allowed_updates = JSON.stringify(params.allowedUpdates);
    return this.call('getUpdates', undefined, { signal, query, timeoutMs: params.timeoutS * 1000 + LONG_POLL_GRACE_MS });
  }

  sendMessage(params: SendMessageParams, signal?: AbortSignal): Promise<TgMessage> {
    return this.call('sendMessage', params, { signal });
  }

  editMessageText(params: EditMessageTextParams, signal?: AbortSignal): Promise<TgMessage | true> {
    return this.call('editMessageText', params, { signal });
  }

  answerCallbackQuery(params: { callback_query_id: string; text?: string }, signal?: AbortSignal): Promise<true> {
    return this.call('answerCallbackQuery', params, { signal });
  }

  sendChatAction(params: { chat_id: number; action: 'typing' }, signal?: AbortSignal): Promise<true> {
    return this.call('sendChatAction', params, { signal });
  }

  /**
   * Call `method`: GET with `query` when there is no body, else POST JSON. Resolves with the
   * `result`; rejects with {@link TelegramApiError} / {@link TelegramNetworkError} (token
   * redacted), or the abort error when `signal` aborted it.
   */
  async call<T>(
    method: string,
    body: object | undefined,
    options: { signal?: AbortSignal | undefined; query?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<T> {
    const url = new URL(`${this.#base}/bot${this.#token}/${method}`);
    for (const [k, v] of Object.entries(options.query ?? {})) url.searchParams.set(k, v);
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    const doFetch = this.#fetch ?? globalThis.fetch;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        signal,
      });
    } catch (err) {
      if (options.signal?.aborted) throw err; // the caller stopped us: not an error to report
      const detail = isAbortError(err) ? 'timed out' : errorText(err);
      throw new TelegramNetworkError(method, redactToken(detail, this.#token));
    }
    let json: { ok?: boolean; result?: unknown; description?: unknown; error_code?: unknown; parameters?: { retry_after?: unknown } } = {};
    try {
      json = (await res.json()) as typeof json;
    } catch {
      // not JSON (a proxy's error page, say)
    }
    if (!res.ok || json.ok !== true) {
      const description = typeof json.description === 'string' ? json.description : res.statusText || 'no description';
      const retryAfter = typeof json.parameters?.retry_after === 'number' ? json.parameters.retry_after : undefined;
      const status = typeof json.error_code === 'number' ? json.error_code : res.ok ? 500 : res.status;
      throw new TelegramApiError(method, status, redactToken(description, this.#token), retryAfter);
    }
    return json.result as T;
  }
}

/** An error's message plus its `cause` (Node's fetch says only "fetch failed" on top). */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : '';
  return `${err.message}${cause}`;
}
