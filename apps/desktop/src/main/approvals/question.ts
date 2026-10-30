/**
 * The question a phone approval shows: a heading line ("🔐 payments wants permission"), then what
 * the agent wants in plain words ("Run: npm test"). It is an ask's body, so the desk note, Telegram
 * and WhatsApp all show it verbatim (Telegram puts the part after the heading in a code block; see
 * `formatForTelegram`).
 *
 * Pure: no I/O, so every tool's wording is unit-tested.
 */

/** Longest part (a command, a path, a plan, JSON) before it is cut with "…". */
export const APPROVAL_PART_MAX = 700;

export interface ApprovalQuestionInput {
  /** The agent's project (folder name); absent: "An agent". */
  project?: string | undefined;
  /** Claude Code's `tool_name`, e.g. `Bash` or `mcp__github__create_issue`. */
  tool: string;
  /** Claude Code's `tool_input` (any JSON). */
  input?: unknown;
}

/** The heading line, e.g. `🔐 payments wants permission`. */
export function approvalHeading(project: string | undefined): string {
  return `🔐 ${project?.trim() || 'An agent'} wants permission`;
}

/** The whole question: the heading, a newline, then what the tool would do. */
export function approvalQuestion(q: ApprovalQuestionInput): string {
  return `${approvalHeading(q.project)}\n${describeToolUse(q.tool, q.input)}`;
}

/** What a tool use would do, in plain words, each long part cut at {@link APPROVAL_PART_MAX}. */
export function describeToolUse(tool: string, input: unknown): string {
  const field = (key: string): string | undefined => {
    const value = isRecord(input) ? input[key] : undefined;
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  };
  switch (tool) {
    case 'Bash': {
      const command = field('command');
      if (!command) break;
      const description = field('description');
      return `Run: ${clip(command)}${description ? `\n(${clip(description)})` : ''}`;
    }
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const path = field('file_path') ?? field('notebook_path');
      if (path) return `Edit ${clip(path)}`;
      break;
    }
    case 'Read':
    case 'Glob':
    case 'Grep': {
      const target = field('file_path') ?? field('path') ?? field('pattern');
      // Glob and Grep: the pattern is what they look for; say where too when given.
      const pattern = tool === 'Read' ? undefined : field('pattern');
      const where = tool === 'Read' ? undefined : field('path');
      if (pattern && where) return `Read ${clip(pattern)} in ${clip(where)}`;
      if (target) return `Read ${clip(target)}`;
      break;
    }
    case 'WebFetch': {
      const url = field('url');
      if (url) return `Open ${clip(url)}`;
      break;
    }
    case 'WebSearch': {
      const query = field('query');
      if (query) return `Search the web for ${clip(query)}`;
      break;
    }
    case 'ExitPlanMode': {
      const plan = field('plan');
      return plan ? `Approve its plan:\n${clip(plan)}` : 'Approve its plan';
    }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool);
  const what = mcp ? `Use ${mcp[2]} (${mcp[1]})` : `Use ${tool}`;
  const json = compactJson(input);
  return json ? `${what}\n${json}` : what;
}

/** `input` as one line of JSON, cut at {@link APPROVAL_PART_MAX}; empty for nothing or `{}`. */
export function compactJson(input: unknown): string {
  if (input === undefined || input === null) return '';
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    return ''; // not JSON (a cycle): the tool name alone will do
  }
  return json === undefined || json === '{}' || json === '[]' ? '' : clip(json);
}

/** `text` cut to {@link APPROVAL_PART_MAX} characters, ending "…", never splitting a surrogate pair. */
export function clip(text: string, max = APPROVAL_PART_MAX): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
