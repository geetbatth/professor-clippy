/**
 * The `clippy` MCP server: tools agents use to leave the user notes, set
 * reminders and ask questions on Professor Clippy's sticky note. Every tool
 * forwards to the desktop app's local API through `ClippyClient`.
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import {
  ClippyNotRunningError,
  DEFAULT_SETTINGS,
  IsoDateTime,
  Settings,
  settingsPath,
  type AskResult,
  type ClippyClient,
} from '@clippy/shared';
import { NOT_RUNNING_MESSAGE, connectToClippy } from './connect';

/** Longest single wait inside `ask_user` before a progress notification is sent. */
export const ASK_SLICE_S = 55;

export interface ClippyServerOptions {
  /** Returns a connected client; throws `ClippyNotRunningError` if the app can't be reached. */
  getClient?: () => Promise<ClippyClient>;
  /** Project name for every message; defaults to the basename of `process.cwd()`. */
  project?: string;
  env?: NodeJS.ProcessEnv;
  /** `ask_user` slice length, seconds (tests shorten it). */
  askSliceS?: number;
}

const ok = (...lines: string[]): CallToolResult => ({ content: lines.map((text) => ({ type: 'text', text })) });

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Default `ask_user` timeout: `askTimeoutDefaultS` from the app's settings.json,
 * else 600. Only that field is validated, so an unrelated bad field can't reset it.
 */
async function defaultAskTimeoutS(): Promise<number> {
  let value: unknown;
  try {
    const raw = JSON.parse(await readFile(settingsPath(), 'utf8'));
    if (raw && typeof raw === 'object') value = raw.askTimeoutDefaultS;
  } catch {
    // missing or unreadable: use the default
  }
  const parsed = Settings.shape.askTimeoutDefaultS.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_SETTINGS.askTimeoutDefaultS;
}

function askResultText(result: AskResult, waitedS: number): CallToolResult {
  if (result.status === 'answered') {
    return ok(JSON.stringify(result), `The user answered${result.answeredVia ? ` (via ${result.answeredVia})` : ''}: ${result.answer ?? ''}`);
  }
  return ok(
    JSON.stringify({ status: 'pending', id: result.id }),
    `No answer yet after ${waitedS} s. The question stays on the user's sticky note; call check_reply with id "${result.id}" later to see if they have answered.`,
  );
}

export function createClippyServer(options: ClippyServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const getClient = options.getClient ?? (() => connectToClippy({ env }));
  const project = options.project ?? basename(process.cwd());
  const askSliceS = options.askSliceS ?? ASK_SLICE_S;

  const server = new McpServer({ name: 'clippy', version: '0.1.0' });

  /** `CLIPPY_SENDER` wins; otherwise the MCP client's name from initialize. */
  const sender = () => env.CLIPPY_SENDER || server.server.getClientVersion()?.name || 'agent';

  /** Run `fn` with a client, turning "app went away" into the friendly tool error. */
  async function withClient<T>(fn: (client: ClippyClient) => Promise<T>, notRunningHint = ''): Promise<T> {
    try {
      return await fn(await getClient());
    } catch (error) {
      if (error instanceof ClippyNotRunningError) throw new Error(NOT_RUNNING_MESSAGE + notRunningHint);
      throw error;
    }
  }

  server.registerTool(
    'leave_message',
    {
      title: 'Leave a message',
      description:
        "Leave a note for the user on Professor Clippy's desktop sticky note (also mirrored to their WhatsApp). " +
        'Use this when the user asks you to leave them a message, notify them, tell them when something is done, or let them know about something. ' +
        'The body is shown verbatim. Set urgent only when the user needs to act soon.',
      inputSchema: {
        body: z.string().min(1).describe('The message, shown to the user exactly as written.'),
        title: z.string().optional().describe('Optional short heading.'),
        urgent: z.boolean().optional().describe('Draws more attention (stronger animation). Default false.'),
      },
    },
    async ({ body, title, urgent }) => {
      const message = await withClient((c) => c.postMessage({ body, title, urgent, sender: sender(), project }));
      return ok(`Left the message on Professor Clippy's sticky note (id ${message.id}).`);
    },
  );

  server.registerTool(
    'remind_me',
    {
      title: 'Set a reminder',
      description:
        'Schedule a reminder that Professor Clippy shows the user (desktop and WhatsApp) at a given time, optionally repeating. ' +
        'Use this when the user asks you to remind them of something later. Convert natural-language times ("tomorrow at 9") ' +
        'to an ISO 8601 timestamp yourself; for repeats pass an RFC 5545 RRULE such as "FREQ=WEEKLY;BYDAY=MO".',
      inputSchema: {
        body: z.string().min(1).describe('What to remind the user about, shown verbatim.'),
        when: IsoDateTime.describe(
          'First due time, ISO 8601, e.g. "2026-11-02T09:00:00" (user\'s local time) or with Z / an offset.',
        ),
        repeat: z.string().min(1).optional().describe('RFC 5545 RRULE for a recurring reminder, e.g. "FREQ=DAILY".'),
      },
    },
    async ({ body, when, repeat }) => {
      const reminder = await withClient((c) =>
        c.createReminder({ body, when, rrule: repeat, sender: sender(), project }),
      );
      return ok(
        `Reminder set (id ${reminder.id}), first due ${iso(reminder.dueAt)}${reminder.rrule ? `, repeating ${reminder.rrule}` : ''}.`,
      );
    },
  );

  server.registerTool(
    'ask_user',
    {
      title: 'Ask the user',
      description:
        "Ask the user a question on Professor Clippy's sticky note (and WhatsApp) and wait for their answer. " +
        'Use this when the user asks you to check with them, or you need their decision before continuing. ' +
        'Waits up to timeout_s seconds (default from the app settings, normally 600). If they have not answered by then it returns ' +
        '{"status":"pending","id":...}; use check_reply with that id later.',
      inputSchema: {
        question: z.string().min(1).describe('The question, shown verbatim.'),
        options: z.array(z.string().min(1)).optional().describe('Suggested answers the user can pick from.'),
        timeout_s: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe('How long to wait for an answer, seconds. 0 = post the question and return immediately.'),
        urgent: z.boolean().optional().describe('Draws more attention (stronger animation). Default false.'),
      },
    },
    async ({ question, options: answerOptions, timeout_s, urgent }, extra) => {
      const timeoutS = timeout_s ?? (await defaultAskTimeoutS());
      const ask = await withClient((c) => c.createAsk({ question, options: answerOptions, urgent, sender: sender(), project }));

      const started = Date.now();
      const deadline = started + timeoutS * 1000;
      const progressToken = extra._meta?.progressToken;
      const lostHint = ` Your question was saved (id ${ask.id}); call check_reply with that id once the app is back.`;
      let result: AskResult = { id: ask.id, status: 'pending' };
      for (let first = true; ; first = false) {
        // Whole seconds left; rounding absorbs a long-poll that returns a few ms early.
        const remainingS = Math.max(0, Math.round((deadline - Date.now()) / 1000));
        if (!first && (remainingS === 0 || extra.signal.aborted)) break;
        if (!first && progressToken !== undefined) {
          const waited = Math.round((Date.now() - started) / 1000);
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress: waited, total: timeoutS, message: `Waiting for the user's answer (${waited}/${timeoutS} s)` },
          });
        }
        result = await withClient((c) => c.waitAsk(ask.id, Math.min(askSliceS, remainingS)), lostHint);
        if (result.status === 'answered') break;
      }
      return askResultText(result, Math.round((Date.now() - started) / 1000));
    },
  );

  server.registerTool(
    'check_reply',
    {
      title: 'Check for a reply',
      description:
        'Check whether the user has answered a question you asked earlier with ask_user that came back pending. Does not wait.',
      inputSchema: { id: z.string().min(1).describe('The id returned by ask_user.') },
    },
    async ({ id }) => askResultText(await withClient((c) => c.waitAsk(id, 0)), 0),
  );

  server.registerTool(
    'list_reminders',
    {
      title: 'List reminders',
      description: "List the user's active Professor Clippy reminders (e.g. when they ask what reminders they have).",
      inputSchema: {},
    },
    async () => {
      const reminders = await withClient((c) => c.listReminders());
      if (reminders.length === 0) return ok('No active reminders.');
      return ok(JSON.stringify(reminders.map((r) => ({ ...r, due: iso(r.dueAt) })), null, 2));
    },
  );

  server.registerTool(
    'cancel_reminder',
    {
      title: 'Cancel a reminder',
      description: 'Cancel one of the user\'s Professor Clippy reminders when they ask you to. Get the id from list_reminders.',
      inputSchema: { id: z.string().min(1).describe('Reminder id from list_reminders or remind_me.') },
    },
    async ({ id }) => {
      await withClient((c) => c.cancelReminder(id));
      return ok(`Cancelled reminder ${id}.`);
    },
  );

  server.registerTool(
    'list_pending_asks',
    {
      title: 'List unanswered questions',
      description: "List questions agents have asked the user through Professor Clippy that the user hasn't answered yet.",
      inputSchema: {},
    },
    async () => {
      const asks = await withClient((c) => c.listPendingAsks());
      if (asks.length === 0) return ok('No unanswered questions.');
      const view = asks.map((a) => ({
        id: a.id,
        question: a.body,
        options: a.options,
        sender: a.sender,
        project: a.project,
        urgent: a.urgent,
        asked: iso(a.createdAt),
      }));
      return ok(JSON.stringify(view, null, 2));
    },
  );

  server.registerTool(
    'answer_pending',
    {
      title: 'Answer a pending question',
      description:
        "Answer one of the user's unanswered questions (from list_pending_asks) on their behalf. " +
        'Use this only when the user has told you what the answer is; the waiting agent receives it as the reply.',
      inputSchema: {
        id: z.string().min(1).describe('Question id from list_pending_asks.'),
        answer: z.string().min(1).describe("The user's answer."),
      },
    },
    async ({ id, answer }) => {
      const result = await withClient((c) => c.answerAsk(id, answer, 'clippy'));
      return ok(JSON.stringify(result), `Answered question ${id}.`);
    },
  );

  return server;
}
