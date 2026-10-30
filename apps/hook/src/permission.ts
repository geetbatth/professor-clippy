/**
 * The `PermissionRequest` hook: while the user is away, an agent's "allow this tool use?" prompt
 * goes to Professor Clippy (desk note, Telegram, WhatsApp) with Allow / Deny, and the user's tap
 * answers the agent (DECISIONS.md, "Phone approvals").
 *
 * The hook only ever prints a decision the user made. Everything else (the app not running, any
 * error, the setting off, the user at the PC, no answer in time, Clippy closing the question) is
 * "no decision": exit 0 with no output, and Claude Code shows its normal terminal prompt.
 */
import {
  APPROVAL_DISMISSED,
  APPROVAL_EXPIRED,
  APPROVAL_WAIT_S,
  APPROVAL_WITHDRAWN,
  type AskResult,
  type ClippyClient,
} from '@clippy/shared';
import { basename } from 'node:path';

/**
 * How long the hook waits for the user, seconds: under the entry's 1800 s `timeout`, so it can
 * still withdraw the question and let the terminal prompt show.
 */
export const HOOK_WAIT_S = APPROVAL_WAIT_S;
/** Tools that need Claude Code's own terminal UI; never sent to the phone. */
export const TERMINAL_ONLY_TOOLS = new Set(['AskUserQuestion']);
export const DENIED_MESSAGE = 'The user denied this from their phone.';
export const REPLIED_PREFIX = 'The user replied from their phone instead of allowing it: ';

export type PermissionDecision = { behavior: 'allow' } | { behavior: 'deny'; message: string };

/** Answers that allow the tool use: Allow, allow, yes, y, ok, approve (trimmed, any case). */
const ALLOW = /^(allow|yes|y|ok|approve)$/i;
/** Answers that deny it with the plain message. */
const DENY = /^(deny|no)$/i;
/** Clippy's own answers when it closes a question nobody answered: no decision. */
const NO_DECISION = new Set([APPROVAL_EXPIRED, APPROVAL_WITHDRAWN, APPROVAL_DISMISSED].map((a) => a.toLowerCase()));

/**
 * The decision for an approval's answer, or undefined for "no decision". This is the only place
 * an `allow` comes from, and only for an explicit Allow-type answer from the user.
 */
export function decisionFor(result: AskResult): PermissionDecision | undefined {
  if (result.status !== 'answered' || result.answer === undefined) return undefined;
  // Clippy answers an open approval only to close it (the user alone may answer one): no decision.
  if (result.answeredVia === 'clippy') return undefined;
  const answer = result.answer.trim();
  if (!answer || NO_DECISION.has(answer.toLowerCase())) return undefined;
  if (ALLOW.test(answer)) return { behavior: 'allow' };
  if (DENY.test(answer)) return { behavior: 'deny', message: DENIED_MESSAGE };
  // Anything else is the user telling the agent something ("use pnpm instead"): deny, and pass it on.
  return { behavior: 'deny', message: `${REPLIED_PREFIX}${answer}` };
}

/** What the hook prints for a decision (Claude Code's `PermissionRequest` output). */
export function hookOutput(decision: PermissionDecision): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } });
}

export interface PermissionDeps {
  client: ClippyClient;
  /** Sender shown on the question. */
  sender: string;
  now?: () => number;
  /** How long to wait for the answer, seconds (a test seam). Default {@link HOOK_WAIT_S}. */
  waitS?: number;
}

/**
 * Ask Professor Clippy for the user's decision on a `PermissionRequest` event. Resolves undefined
 * for "no decision"; rejects only when the app can't be asked at all (the caller treats that as
 * no decision too).
 */
export async function requestDecision(input: Record<string, any>, deps: PermissionDeps): Promise<PermissionDecision | undefined> {
  const tool = typeof input.tool_name === 'string' ? input.tool_name : '';
  if (!tool || TERMINAL_ONLY_TOOLS.has(tool)) return undefined;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : undefined;
  const now = deps.now ?? Date.now;
  const { client } = deps;

  const request = await client.requestApproval({
    ...(typeof input.session_id === 'string' && input.session_id && { sessionId: input.session_id }),
    ...(cwd !== undefined && { cwd }),
    ...(cwd !== undefined && basename(cwd) && { project: basename(cwd) }),
    tool,
    input: input.tool_input ?? {},
    sender: deps.sender,
  });
  if (request.status !== 'waiting') return undefined; // off, or the user is at the PC

  const deadline = now() + (deps.waitS ?? HOOK_WAIT_S) * 1000;
  try {
    for (;;) {
      const remainingS = Math.ceil((deadline - now()) / 1000);
      if (remainingS <= 0) break;
      const result = await client.waitAsk(request.id, remainingS);
      if (result.status === 'answered') return decisionFor(result);
    }
  } catch {
    // The app went away or the ask is gone: give up like a timeout.
  }
  // Nobody answered in time: take the question down, and let the terminal prompt show.
  await client.withdrawApproval(request.id).catch(() => {});
  return undefined;
}
