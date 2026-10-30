/**
 * Parser for `claude -p --output-format stream-json --verbose [--include-partial-messages]`.
 *
 * The CLI writes one JSON object per line. What matters here:
 * - `{type:'system', subtype:'init', session_id}`: the session id (also on every later line).
 * - `{type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}`:
 *   streamed text (only with `--include-partial-messages`).
 * - `{type:'assistant', message:{id, content:[{type:'text', text} | {type:'tool_use', ...}]}}`:
 *   each finished assistant message. Its text is used only when that message was not streamed.
 * - `{type:'result', is_error, subtype, result, errors?, session_id}`: the end of the turn.
 *
 * Lines from subagents (`parent_tool_use_id` set) are ignored. Unknown or malformed lines are
 * skipped. Separate text blocks (e.g. before and after a tool call) are joined with a blank line,
 * so the streamed deltas always add up to {@link StreamJsonParser.reply}.
 */

export type BrainStreamEvent =
  | { type: 'session'; sessionId: string }
  /** Text to append to the reply (already includes any block separator). */
  | { type: 'text'; text: string }
  | {
      type: 'result';
      ok: boolean;
      /** `result` field: the final assistant text, or the error text when `ok` is false. */
      text?: string;
      /** `errors` field (e.g. "No conversation found with session ID: ..."). */
      errors: string[];
      sessionId?: string;
    };

const BLOCK_SEPARATOR = '\n\n';

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class StreamJsonParser {
  #buffer = '';
  #reply = '';
  #sessionId: string | undefined;
  #result: Extract<BrainStreamEvent, { type: 'result' }> | undefined;
  /** Assistant message ids whose text arrived as stream events. */
  readonly #streamed = new Set<string>();
  /** `<message id>:<block index>` of the block the last delta belonged to. */
  #lastBlock: string | undefined;
  /** Set when the CLI reported an authentication failure (e.g. "Not logged in"). */
  #authFailed = false;

  constructor(private readonly onEvent: (event: BrainStreamEvent) => void = () => {}) {}

  /** All reply text so far (the sum of every `text` event). */
  get reply(): string {
    return this.#reply;
  }

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  /** The `result` line, once seen. */
  get result(): Extract<BrainStreamEvent, { type: 'result' }> | undefined {
    return this.#result;
  }

  get authFailed(): boolean {
    return this.#authFailed;
  }

  /** Feed a chunk of stdout (any split; lines are reassembled). */
  push(chunk: string): void {
    this.#buffer += chunk;
    let nl: number;
    while ((nl = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, nl);
      this.#buffer = this.#buffer.slice(nl + 1);
      this.#line(line);
    }
  }

  /** Flush a final line that had no trailing newline. */
  end(): void {
    const rest = this.#buffer;
    this.#buffer = '';
    if (rest.trim()) this.#line(rest);
  }

  #line(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isObject(obj)) return;
    if (typeof obj.session_id === 'string' && obj.session_id !== this.#sessionId) {
      this.#sessionId = obj.session_id;
      this.onEvent({ type: 'session', sessionId: obj.session_id });
    }
    // Subagent chatter is not part of Clippy's reply.
    if (obj.parent_tool_use_id !== undefined && obj.parent_tool_use_id !== null) return;

    switch (obj.type) {
      case 'stream_event':
        this.#streamEvent(obj);
        break;
      case 'assistant':
        this.#assistant(obj);
        break;
      case 'result':
        this.#resultLine(obj);
        break;
    }
  }

  #streamEvent(obj: Json): void {
    const event = obj.event;
    if (!isObject(event)) return;
    const messageId = typeof obj.api_message_id === 'string' ? obj.api_message_id : 'stream';
    if (event.type === 'message_start' && isObject(event.message) && typeof event.message.id === 'string') {
      this.#streamed.add(event.message.id);
    }
    if (event.type !== 'content_block_delta') return;
    const delta = event.delta;
    if (!isObject(delta) || delta.type !== 'text_delta' || typeof delta.text !== 'string' || !delta.text) return;
    this.#streamed.add(messageId);
    const block = `${messageId}:${String(event.index ?? 0)}`;
    const startsBlock = block !== this.#lastBlock;
    this.#lastBlock = block;
    this.#append(delta.text, startsBlock);
  }

  #assistant(obj: Json): void {
    const message = obj.message;
    if (!isObject(message)) return;
    if (obj.error === 'authentication_failed') this.#authFailed = true;
    // Synthetic error messages ("Not logged in · Please run /login") are not Clippy talking.
    if (obj.is_api_error_message === true) return;
    if (typeof message.id === 'string' && this.#streamed.has(message.id)) return;
    if (!Array.isArray(message.content)) return;
    for (const block of message.content) {
      if (isObject(block) && block.type === 'text' && typeof block.text === 'string' && block.text) {
        this.#lastBlock = undefined;
        this.#append(block.text, true);
      }
    }
  }

  #resultLine(obj: Json): void {
    const errors = Array.isArray(obj.errors) ? obj.errors.filter((e): e is string => typeof e === 'string') : [];
    const event: Extract<BrainStreamEvent, { type: 'result' }> = {
      type: 'result',
      ok: obj.is_error !== true && obj.subtype === 'success',
      errors,
      ...(typeof obj.result === 'string' && { text: obj.result }),
      ...(typeof obj.session_id === 'string' && { sessionId: obj.session_id }),
    };
    this.#result = event;
    this.onEvent(event);
  }

  #append(text: string, startsBlock: boolean): void {
    const out = startsBlock && this.#reply ? BLOCK_SEPARATOR + text : text;
    this.#reply += out;
    this.onEvent({ type: 'text', text: out });
  }
}
