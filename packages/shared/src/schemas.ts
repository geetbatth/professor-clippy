/**
 * Core domain contracts: messages, reminders, asks and their API inputs.
 *
 * Each export is both a zod schema (runtime value) and the inferred TypeScript
 * type of the same name, so `Message.parse(x)` and `const m: Message` both work.
 *
 * All timestamps are Unix epoch **milliseconds** (`Date.now()` style).
 */
import { z } from 'zod';

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

/** What an agent's note is about, for notes the hook files: the agent finished, or it needs a permission. */
export const AgentEvent = z.enum(['agent-finished', 'agent-needs-permission']);
export type AgentEvent = z.infer<typeof AgentEvent>;

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
  /** For a note from the hook: what happened (what a watch listens for). */
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
  event: AgentEvent.optional(),
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

/** Filter for listing messages (`GET /messages` query, IPC `listMessages`). `q` is a full-text (FTS) search. */
export const MessageFilter = z.object({
  state: MessageState.optional(),
  kind: MessageKind.optional(),
  q: z.string().optional(),
});
export type MessageFilter = z.infer<typeof MessageFilter>;
