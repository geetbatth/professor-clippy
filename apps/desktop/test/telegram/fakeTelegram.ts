/**
 * A fake Telegram Bot API on 127.0.0.1: a real HTTP server speaking `/bot<token>/<method>`,
 * so the client's fetch, JSON, long-polling and error handling are exercised for real.
 *
 * - `getUpdates` answers at once with any queued update at or after `offset` (or with none when
 *   `timeout` is 0), otherwise holds the request until one is pushed (or the client aborts /
 *   the server closes).
 * - `sendMessage` returns increasing `message_id`s; every call is recorded.
 * - `failNext(method, ...)` makes the next calls of a method fail with a given status/body.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { SecretBox } from '../../src/main/settings';
import type { TgUpdate } from '../../src/main/telegram/api';

export interface Call {
  /** The bot token the call used. */
  token: string;
  method: string;
  params: Record<string, unknown>;
  at: number;
}

interface Failure {
  status: number;
  body: Record<string, unknown>;
}

export class FakeTelegram {
  readonly token: string;
  readonly calls: Call[] = [];
  /** Requests with a token other than {@link token}. */
  readonly wrongToken: string[] = [];
  #server: Server;
  #updates: TgUpdate[] = [];
  #nextUpdateId = 1000;
  #nextMessageId = 1;
  #waiting = new Set<{ offset: number; res: ServerResponse }>();
  #failures = new Map<string, Failure[]>();
  #delays = new Map<string, number[]>();
  /** Other bot tokens this server answers for (a second bot). */
  readonly #tokens = new Set<string>();
  #me = { id: 7000001, is_bot: true, first_name: 'Professor Clippy', username: 'ProfessorClippyBot' };

  private constructor(token: string) {
    this.token = token;
    this.#server = createServer((req, res) => void this.#handle(req, res));
  }

  static async start(token = '7000001:AAFakeTokenForTestsOnly_abcdefghijk'): Promise<FakeTelegram> {
    const fake = new FakeTelegram(token);
    await new Promise<void>((resolve) => fake.#server.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    for (const w of this.#waiting) w.res.destroy();
    this.#waiting.clear();
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  /** Calls of one method (params only). */
  of(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  /** Text of every `sendMessage`. */
  get sentTexts(): string[] {
    return this.of('sendMessage').map((p) => String(p.text));
  }

  /** Queue an update (gets the next `update_id`) and wake any waiting long-poll. */
  push(update: Omit<TgUpdate, 'update_id'> & { update_id?: number }): TgUpdate {
    const u = { update_id: update.update_id ?? this.#nextUpdateId++, ...update } as TgUpdate;
    this.#updates.push(u);
    for (const w of [...this.#waiting]) {
      const ready = this.#updates.filter((x) => x.update_id >= w.offset);
      if (ready.length) {
        this.#waiting.delete(w);
        this.#reply(w.res, 200, { ok: true, result: ready });
      }
    }
    return u;
  }

  /** A private text message from `chat` (default: the user 4242 "Geet"). */
  text(text: string, options: { chatId?: number; type?: string; firstName?: string; replyTo?: number } = {}): TgUpdate {
    const chatId = options.chatId ?? 4242;
    return this.push({
      message: {
        message_id: this.#nextMessageId++,
        date: 1,
        chat: { id: chatId, type: options.type ?? 'private', first_name: options.firstName ?? 'Geet' },
        from: { id: chatId, first_name: options.firstName ?? 'Geet' },
        text,
        ...(options.replyTo !== undefined && { reply_to_message: { message_id: options.replyTo, chat: { id: chatId, type: 'private' } } }),
      },
    });
  }

  /** A tap on an inline button of message `messageId`. */
  tap(data: string, messageId: number, options: { chatId?: number; fromId?: number; type?: string } = {}): TgUpdate {
    const chatId = options.chatId ?? 4242;
    return this.push({
      callback_query: {
        id: `cq${this.#nextUpdateId}`,
        from: { id: options.fromId ?? chatId, first_name: 'Geet' },
        message: { message_id: messageId, chat: { id: chatId, type: options.type ?? 'private' } },
        data,
      },
    });
  }

  /** The next `count` calls of `method` fail with `status` (and `body` merged into the error). */
  failNext(method: string, status: number, body: Record<string, unknown> = {}, count = 1): void {
    const list = this.#failures.get(method) ?? [];
    for (let i = 0; i < count; i++) list.push({ status, body: { ok: false, error_code: status, description: `Fake ${status}`, ...body } });
    this.#failures.set(method, list);
  }

  /** Also answer for this bot token (a second bot). */
  addToken(token: string): void {
    this.#tokens.add(token);
  }

  /** The next call of `method` is answered only after `ms` (a send still in flight). */
  delayNext(method: string, ms: number): void {
    const list = this.#delays.get(method) ?? [];
    list.push(ms);
    this.#delays.set(method, list);
  }

  /** Number of long-polls currently held open. */
  get waitingPolls(): number {
    return this.#waiting.size;
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
    if (!m) return this.#reply(res, 404, { ok: false, error_code: 404, description: 'Not Found' });
    const [, token, method] = m as unknown as [string, string, string];
    let params: Record<string, unknown> = Object.fromEntries(url.searchParams);
    if (req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (chunks.length) params = { ...params, ...(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) };
    }
    if (token !== this.token && !this.#tokens.has(token)) {
      this.wrongToken.push(method);
      return this.#reply(res, 401, { ok: false, error_code: 401, description: 'Unauthorized' });
    }
    this.calls.push({ token, method, params, at: Date.now() });
    const delay = this.#delays.get(method)?.shift();
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const failure = this.#failures.get(method)?.shift();
    if (failure) return this.#reply(res, failure.status, failure.body);

    switch (method) {
      case 'getMe':
        return this.#reply(res, 200, { ok: true, result: this.#me });
      case 'getUpdates': {
        const offset = Number(params.offset ?? 0);
        // Like Telegram: an offset confirms (drops) every update before it.
        this.#updates = this.#updates.filter((u) => u.update_id >= offset);
        if (this.#updates.length || Number(params.timeout ?? 0) === 0) return this.#reply(res, 200, { ok: true, result: this.#updates });
        const w = { offset, res };
        this.#waiting.add(w);
        res.on('close', () => this.#waiting.delete(w));
        return;
      }
      case 'sendMessage':
        return this.#reply(res, 200, {
          ok: true,
          result: { message_id: this.#nextMessageId++, date: 1, chat: { id: params.chat_id, type: 'private' }, text: params.text },
        });
      case 'editMessageText':
        return this.#reply(res, 200, { ok: true, result: { message_id: params.message_id, chat: { id: params.chat_id, type: 'private' }, text: params.text } });
      case 'answerCallbackQuery':
      case 'sendChatAction':
        return this.#reply(res, 200, { ok: true, result: true });
      default:
        return this.#reply(res, 404, { ok: false, error_code: 404, description: 'Not Found: method not found' });
    }
  }

  #reply(res: ServerResponse, status: number, body: unknown): void {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

/** Poll `check` until it returns truthy (or fail after `timeoutMs`). */
export async function waitFor<T>(check: () => T | undefined | false | null, timeoutMs = 3000, label = 'condition'): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/**
 * Make `fetch` throw for anything but 127.0.0.1, so a test can never reach the real Telegram
 * (or anything else). Returns the list of every URL fetched and a restore function.
 */
export function guardFetch(): { urls: string[]; restore(): void } {
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: Request | string | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    urls.push(url);
    if (new URL(url).hostname !== '127.0.0.1') throw new Error(`unexpected network call in a test: ${new URL(url).hostname}`);
    return real(input, init);
  }) as typeof fetch;
  return {
    urls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

/** Reversible stand-in for Electron safeStorage (the stored form is never the plaintext). */
export const fakeSecrets: SecretBox = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`v10${[...plain].reverse().join('')}`).toString('base64'),
  decrypt: (stored) => {
    const raw = Buffer.from(stored, 'base64').toString('utf8');
    if (!raw.startsWith('v10')) throw new Error('bad ciphertext');
    return [...raw.slice(3)].reverse().join('');
  },
};
