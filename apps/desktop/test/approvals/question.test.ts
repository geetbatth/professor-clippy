import { describe, expect, it } from 'vitest';
import { APPROVAL_PART_MAX, approvalHeading, approvalQuestion, clip, compactJson, describeToolUse } from '../../src/main/approvals/question';

describe('approvalQuestion', () => {
  it('is the heading, then what the tool would do', () => {
    expect(approvalQuestion({ project: 'payments', tool: 'Bash', input: { command: 'npm test' } })).toBe('🔐 payments wants permission\nRun: npm test');
    expect(approvalHeading(undefined)).toBe('🔐 An agent wants permission');
    expect(approvalHeading('  ')).toBe('🔐 An agent wants permission');
  });
});

describe('describeToolUse', () => {
  it('Bash: the command, and its description when there is one', () => {
    expect(describeToolUse('Bash', { command: 'git push --force' })).toBe('Run: git push --force');
    expect(describeToolUse('Bash', { command: 'rm -rf dist', description: 'Clean the build' })).toBe('Run: rm -rf dist\n(Clean the build)');
    expect(describeToolUse('Bash', { command: 'a\nb' })).toBe('Run: a\nb');
  });

  it.each(['Edit', 'Write', 'MultiEdit'])('%s: the file', (tool) => {
    expect(describeToolUse(tool, { file_path: 'C:/code/app/src/main.ts', old_string: 'x', new_string: 'y' })).toBe('Edit C:/code/app/src/main.ts');
  });

  it('NotebookEdit: the notebook', () => {
    expect(describeToolUse('NotebookEdit', { notebook_path: '/n/analysis.ipynb', new_source: 'x' })).toBe('Edit /n/analysis.ipynb');
  });

  it('Read, Glob and Grep: the path or the pattern', () => {
    expect(describeToolUse('Read', { file_path: '/etc/hosts' })).toBe('Read /etc/hosts');
    expect(describeToolUse('Glob', { pattern: '**/*.env' })).toBe('Read **/*.env');
    expect(describeToolUse('Grep', { pattern: 'API_KEY', path: '/home/me' })).toBe('Read API_KEY in /home/me');
  });

  it('WebFetch and WebSearch', () => {
    expect(describeToolUse('WebFetch', { url: 'https://example.com/a', prompt: 'summarise' })).toBe('Open https://example.com/a');
    expect(describeToolUse('WebSearch', { query: 'zod 4 enum exclude' })).toBe('Search the web for zod 4 enum exclude');
  });

  it('ExitPlanMode: approve its plan, with the plan cut short', () => {
    expect(describeToolUse('ExitPlanMode', { plan: '1. Do it\n2. Test it' })).toBe('Approve its plan:\n1. Do it\n2. Test it');
    expect(describeToolUse('ExitPlanMode', {})).toBe('Approve its plan');
    const long = describeToolUse('ExitPlanMode', { plan: 'p'.repeat(5000) });
    expect(long.length).toBeLessThanOrEqual('Approve its plan:\n'.length + APPROVAL_PART_MAX);
    expect(long.endsWith('…')).toBe(true);
  });

  it('MCP tools: the tool and its server, then the input as compact JSON', () => {
    expect(describeToolUse('mcp__github__create_issue', { repo: 'a/b', title: 'Bug' })).toBe('Use create_issue (github)\n{"repo":"a/b","title":"Bug"}');
    expect(describeToolUse('mcp__claude_ai_Gmail__send_message', { to: 'x' })).toBe('Use send_message (claude_ai_Gmail)\n{"to":"x"}');
    expect(describeToolUse('mcp__clippy__list_reminders', {})).toBe('Use list_reminders (clippy)');
  });

  it('anything else: the tool name and its input', () => {
    expect(describeToolUse('Task', { prompt: 'look around' })).toBe('Use Task\n{"prompt":"look around"}');
    expect(describeToolUse('SomethingNew', undefined)).toBe('Use SomethingNew');
    // A known tool without the field it needs falls back to the same.
    expect(describeToolUse('Bash', { cmd: 'ls' })).toBe('Use Bash\n{"cmd":"ls"}');
    expect(describeToolUse('Read', 'not an object')).toBe('Use Read\n"not an object"');
  });

  it('cuts a long command at about 700 characters with an ellipsis', () => {
    const text = describeToolUse('Bash', { command: 'x'.repeat(2000) });
    expect(text).toBe(`Run: ${'x'.repeat(APPROVAL_PART_MAX - 1)}…`);
    expect(APPROVAL_PART_MAX).toBe(700);
  });
});

describe('helpers', () => {
  it('clip keeps short text and never splits a surrogate pair', () => {
    expect(clip('short')).toBe('short');
    expect(Array.from(clip('😀'.repeat(800)))).toHaveLength(APPROVAL_PART_MAX);
  });

  it('compactJson: empty for nothing, and never throws', () => {
    expect(compactJson(undefined)).toBe('');
    expect(compactJson(null)).toBe('');
    expect(compactJson({})).toBe('');
    expect(compactJson([])).toBe('');
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(compactJson(cycle)).toBe('');
    expect(compactJson({ a: 'x'.repeat(1000) }).length).toBe(APPROVAL_PART_MAX);
  });
});
