/**
 * Core domain contracts: messages, reminders, asks, standing orders, watches, pages and their API inputs.
 *
 * Each export is both a zod schema (runtime value) and the inferred TypeScript
 * type of the same name, so `Message.parse(x)` and `const m: Message` both work.
 *
 * All timestamps are Unix epoch **milliseconds** (`Date.now()` style).
 */
import { z } from 'zod';
import { PageColor } from './theme';

/** Epoch-milliseconds timestamp. */
export const Timestamp = z.number().int().nonnegative();
export type Timestamp = z.infer<typeof Timestamp>;

/** What a message is: an agent note, a fired reminder, a question awaiting an answer, or a chat line. */
export const MessageKind = z.enum(['note', 'reminder', 'ask', 'chat']);
export type MessageKind = z.infer<typeof MessageKind>;

/** Lifecycle of a message on the sticky note. `done` messages live in the searchable history. */
export const MessageState = z.enum(['unread', 'done', 'snoozed']);
export type MessageState = z.infer<typeof MessageState>;

/** Where an ask was answered from. */
export const AnsweredVia = z.enum(['desk', 'whatsapp', 'telegram', 'clippy']);
export type AnsweredVia = z.infer<typeof AnsweredVia>;

/**
 * What a message from an agent is about: the hook's notes (the agent finished, or it needs a
 * permission) and, on an ask only, `agent-permission-request`: an agent's permission request the
 * user approves from the phone while away (`main/approvals`). Only the app itself stores that one.
 */
export const AgentEvent = z.enum(['agent-finished', 'agent-needs-permission', 'agent-permission-request']);
export type AgentEvent = z.infer<typeof AgentEvent>;

/** The events a note posted through the API may carry (never `agent-permission-request`). */
export const NoteEvent = AgentEvent.exclude(['agent-permission-request']);
export type NoteEvent = z.infer<typeof NoteEvent>;

/** Who wrote a chat line (only meaningful for `kind: 'chat'`). */
export const ChatRole = z.enum(['user', 'clippy']);
export type ChatRole = z.infer<typeof ChatRole>;

/**
 * A single item shown on the sticky note and stored in history.
 * `body` is the agent's text, shown verbatim (never rewritten).
 */
export const Message = z.object({
  /** ULID; sorts by creation time. */
  id: z.ulid(),
  kind: MessageKind,
  /** Verbatim text. */
  body: z.string(),
  title: z.string().optional(),
  /** Agent / client name that sent it (e.g. "claude-code"), or "clippy"/"user" for chat. */
  sender: z.string(),
  /** Project folder name the sender was working in. */
  project: z.string().optional(),
  /** Triggers the stronger attention animation. */
  urgent: z.boolean(),
  state: MessageState,
  createdAt: Timestamp,
  doneAt: Timestamp.optional(),
  snoozedUntil: Timestamp.optional(),
  /** WhatsApp message id of the mirrored copy (used to match quote-replies). */
  waId: z.string().optional(),
  /**
   * Telegram `message_id` of the mirrored copy in the paired chat (used to route replies and
   * button taps, and to edit an answered ask). Optional, so older stored messages still parse.
   */
  tgMsgId: z.number().int().optional(),
  /** Suggested answers for an `ask`. */
  options: z.array(z.string()).optional(),
  /** The answer to an `ask`, once given. */
  answer: z.string().optional(),
  answeredVia: AnsweredVia.optional(),
  /** Only for `kind: 'chat'`. */
  role: ChatRole.optional(),
  /** For `kind: 'reminder'`: the reminder fired while the PC was off. */
  missed: z.boolean().optional(),
  /**
   * Posted as away-only (the hook's "agent finished" notes). If the user was at the PC when it
   * arrived, it was stored straight into history, silently, and not mirrored.
   */
  quietIfActive: z.boolean().optional(),
  /** For an `ask` answered automatically: the standing order that answered it. */
  orderId: z.string().optional(),
  /** For a note from the hook: what happened (what a watch listens for). For an ask: a phone approval. */
  event: AgentEvent.optional(),
});
export type Message = z.infer<typeof Message>;

/** A scheduled (optionally recurring) reminder. When it fires it produces a `kind: 'reminder'` Message. */
export const Reminder = z.object({
  /** ULID. */
  id: z.ulid(),
  body: z.string(),
  sender: z.string(),
  project: z.string().optional(),
  /** Next time this reminder fires. */
  dueAt: Timestamp,
  /** RFC 5545 RRULE string (e.g. "FREQ=WEEKLY;BYDAY=MO") for recurring reminders. */
  rrule: z.string().min(1).optional(),
  /** False once a one-off reminder has fired or the reminder was cancelled. */
  active: z.boolean(),
  createdAt: Timestamp,
  lastFiredAt: Timestamp.optional(),
});
export type Reminder = z.infer<typeof Reminder>;

/** Body of `POST /messages` (MCP `leave_message`, hook). `urgent` defaults to false server-side. */
export const NewMessageInput = z.object({
  body: z.string().min(1),
  title: z.string().optional(),
  sender: z.string().min(1),
  project: z.string().optional(),
  urgent: z.boolean().optional(),
  /**
   * Only interrupt the user if they are away: when the PC has had input within the app's
   * `awayThresholdS`, the note goes straight into history (no pop-up, sound or phone mirror).
   * Optional; older apps ignore it.
   */
  quietIfActive: z.boolean().optional(),
  /** What the note is about (the hook sets it); lets watches tell "agent finished" from the rest. Optional; older apps ignore it. */
  event: NoteEvent.optional(),
});
export type NewMessageInput = z.infer<typeof NewMessageInput>;

/**
 * ISO 8601 date-time. Accepts `Z`, a `±hh:mm` offset, or no offset (interpreted
 * as the PC's local time). Minutes precision is enough; seconds/fractions optional.
 * Agents convert natural language ("tomorrow 9am") to this themselves.
 */
export const IsoDateTime = z.iso
  .datetime({ offset: true, local: true })
  // zod requires seconds when there is a `Z`/offset; also accept minute precision (`2026-10-30T09:00Z`).
  .or(z.iso.datetime({ offset: true, precision: -1 }));
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Body of `POST /reminders` (MCP `remind_me`). */
export const NewReminderInput = z.object({
  body: z.string().min(1),
  /** First due time, ISO 8601. */
  when: IsoDateTime,
  /** RFC 5545 RRULE for recurring reminders, e.g. "FREQ=WEEKLY;BYDAY=MO". */
  rrule: z.string().min(1).optional(),
  sender: z.string().min(1),
  project: z.string().optional(),
});
export type NewReminderInput = z.infer<typeof NewReminderInput>;

/** Body of `POST /asks` (MCP `ask_user`). Returns the created `kind: 'ask'` Message. */
export const NewAskInput = z.object({
  question: z.string().min(1),
  options: z.array(z.string().min(1)).optional(),
  sender: z.string().min(1),
  project: z.string().optional(),
  urgent: z.boolean().optional(),
});
export type NewAskInput = z.infer<typeof NewAskInput>;

/** Result of waiting on / answering an ask. `pending` = no answer yet; poll again later with the same id. */
export const AskResult = z.object({
  id: z.string(),
  status: z.enum(['answered', 'pending']),
  answer: z.string().optional(),
  answeredVia: AnsweredVia.optional(),
});
export type AskResult = z.infer<typeof AskResult>;

/**
 * A standing order: an instruction the user gave Clippy to answer agents' questions of a
 * certain kind for them ("When an agent asks which branch to use, answer: staging").
 */
export const StandingOrder = z.object({
  /** ULID. */
  id: z.ulid(),
  /** The instruction, in the user's words. */
  text: z.string(),
  /** False once cancelled. */
  active: z.boolean(),
  createdAt: Timestamp,
});
export type StandingOrder = z.infer<typeof StandingOrder>;

/** Body of `POST /orders` (MCP `add_standing_order`, Settings). */
export const NewStandingOrderInput = z.object({ text: z.string().min(1).max(500) });
export type NewStandingOrderInput = z.infer<typeof NewStandingOrderInput>;

/** What a watch waits for: an agent finishing, or anything at all from the project. */
export const WatchEvent = z.enum(['finished', 'any']);
export type WatchEvent = z.infer<typeof WatchEvent>;

/**
 * A watch: "when this agent finishes, remind me to ...". It fires once, as a note from Clippy
 * carrying `nudge`, the next time a matching note or question arrives, then goes inactive.
 */
export const Watch = z.object({
  /** ULID. */
  id: z.ulid(),
  /** Matches an agent's project name as a case-insensitive substring; absent: any project. */
  project: z.string().optional(),
  event: WatchEvent,
  /** What to remind the user of when it fires. */
  nudge: z.string(),
  /** False once it has fired or been cancelled. */
  active: z.boolean(),
  createdAt: Timestamp,
  /** When it fired (absent if cancelled without firing). */
  firedAt: Timestamp.optional(),
});
export type Watch = z.infer<typeof Watch>;

/** Body of `POST /watches` (MCP `watch_for`, Settings). `event` defaults to `finished`. */
export const NewWatchInput = z.object({
  project: z.string().min(1).max(200).optional(),
  event: WatchEvent.optional(),
  nudge: z.string().min(1).max(500),
});
export type NewWatchInput = z.infer<typeof NewWatchInput>;

/** The author of a page the user wrote (IPC only; the local API never accepts it as a sender). */
export const PAGE_USER_AUTHOR = 'you';
/** Longest page title, characters. */
export const PAGE_TITLE_MAX = 120;
/** Longest page body, characters. */
export const PAGE_BODY_MAX = 100_000;

/** A page title: 1 to 120 characters, not only spaces. */
export const PageTitle = z.string().max(PAGE_TITLE_MAX).regex(/\S/, 'A page needs a title');
/** A page body: up to 100 000 characters. */
export const PageBody = z.string().max(PAGE_BODY_MAX);

/** Where a popped-out page's window was last (screen pixels) and on which display (Electron display id). */
export const PageBounds = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  displayId: z.number().int(),
});
export type PageBounds = z.infer<typeof PageBounds>;

/**
 * A page on the Pad: the user's own notes, which save as they type, and which Clippy's brain and
 * agents can write too. An agent may change only the pages it wrote; the user and the brain any.
 */
export const Page = z.object({
  /** ULID. */
  id: z.ulid(),
  title: PageTitle,
  body: PageBody,
  /** Paper colour; `null` follows the theme. */
  color: PageColor.nullable(),
  /** Kept at the top of the list (and never archived for being old). */
  pinned: z.boolean(),
  /** Open as its own little window on the desktop. */
  popped: z.boolean(),
  popBounds: PageBounds.nullable(),
  /** `'you'` for the user, else the sender that created it (`clippy-brain`, `claude-code`, ...). Never changes. */
  author: z.string(),
  /** Project folder of the agent that created it. */
  project: z.string().nullable(),
  /** Written by someone else and not opened by the user since. */
  unseen: z.boolean(),
  createdAt: Timestamp,
  /** Last change to the title, body, colour or pin (strictly increasing; a save's `baseUpdatedAt`). */
  updatedAt: Timestamp,
  archivedAt: Timestamp.nullable(),
});
export type Page = z.infer<typeof Page>;

/** A new page (`POST /pages` adds `sender`; IPC `createPage` writes as the user). */
export const NewPageInput = z.object({
  title: PageTitle,
  body: PageBody.optional(),
  color: PageColor.nullable().optional(),
  project: z.string().min(1).max(200).optional(),
});
export type NewPageInput = z.infer<typeof NewPageInput>;

/**
 * A change to a page. `body` replaces the text; `append` adds a line to it (not both).
 * `baseUpdatedAt` is the `updatedAt` the writer last saw: if the page changed since, the change
 * is refused (409) with the page as it is now, so nobody's words are silently lost.
 */
export const PageChange = z
  .object({
    title: PageTitle.optional(),
    body: PageBody.optional(),
    append: z.string().min(1).max(PAGE_BODY_MAX).optional(),
    color: PageColor.nullable().optional(),
    pinned: z.boolean().optional(),
    baseUpdatedAt: Timestamp.optional(),
  })
  .strict();
export type PageChange = z.infer<typeof PageChange>;

/** Filter for listing pages (`GET /pages`, IPC `listPages`). Not archived unless `archived`. */
export const PageFilter = z.object({
  /** Case-insensitive part of the title or body. */
  q: z.string().optional(),
  archived: z.boolean().optional(),
});
export type PageFilter = z.infer<typeof PageFilter>;

/** `body` with `text` added: on a new line, unless the body is empty or already ends in one. */
export function appendToBody(body: string, text: string): string {
  return body === '' || body.endsWith('\n') ? body + text : `${body}\n${text}`;
}

/**
 * The page a title refers to: one whose title matches exactly (any case; the most recently changed
 * if several do), else the only one whose title starts with it. Undefined if none, or if the
 * prefix fits several pages.
 */
export function findPageByTitle(pages: readonly Page[], title: string): Page | undefined {
  const wanted = title.trim().toLowerCase();
  if (wanted === '') return undefined;
  const newest = (list: Page[]) => list.reduce<Page | undefined>((best, p) => (!best || p.updatedAt > best.updatedAt ? p : best), undefined);
  const exact = pages.filter((p) => p.title.trim().toLowerCase() === wanted);
  if (exact.length > 0) return newest(exact);
  const prefix = pages.filter((p) => p.title.trim().toLowerCase().startsWith(wanted));
  return prefix.length === 1 ? prefix[0] : undefined;
}

/** Filter for listing messages (`GET /messages` query, IPC `listMessages`). `q` is a full-text (FTS) search. */
export const MessageFilter = z.object({
  state: MessageState.optional(),
  kind: MessageKind.optional(),
  q: z.string().optional(),
});
export type MessageFilter = z.infer<typeof MessageFilter>;
