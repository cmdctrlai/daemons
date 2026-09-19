/**
 * One tool call, written two ways: the verbose line a client reads and the
 * descriptor voice mode narrates. The live stream and the replay of a finished
 * turn share both, so a call must read the same whichever path produced it.
 */

import { formatToolUse, normalizeToolUse } from './tool-format';

describe('formatToolUse', () => {
  const cases: Array<{ name: string; tool: string; input?: Record<string, unknown>; want: string }> = [
    { name: 'Read names the file', tool: 'Read', input: { file_path: '/a/b/main.go' }, want: '\u{1F4D6} Reading /a/b/main.go' },
    { name: 'Write names the file', tool: 'Write', input: { file_path: 'x.ts' }, want: '\u{270F}\u{FE0F} Writing x.ts' },
    { name: 'Edit names the file', tool: 'Edit', input: { file_path: 'y.ts' }, want: '\u{1F527} Editing y.ts' },
    { name: 'Bash truncates the command to 60', tool: 'Bash', input: { command: 'a'.repeat(80) }, want: '\u{26A1} Running: ' + 'a'.repeat(60) },
    { name: 'Grep names the pattern', tool: 'Grep', input: { pattern: 'func main' }, want: '\u{1F50E} Grepping: func main' },
    { name: 'Glob names the pattern', tool: 'Glob', input: { pattern: '**/*.ts' }, want: '\u{1F50D} Searching: **/*.ts' },
    { name: 'Task names the subagent work', tool: 'Task', input: { description: 'fix the bug' }, want: '\u{1F4CB} Spawning task: fix the bug' },
    { name: 'TodoWrite needs no argument', tool: 'TodoWrite', input: {}, want: '\u{1F4DD} Updating todos' },
    { name: 'a missing file_path falls back', tool: 'Read', input: undefined, want: '\u{1F4D6} Reading file' },
    { name: 'an unknown tool shows its name', tool: 'CustomThing', input: { foo: 'bar' }, want: '\u{1F527} CustomThing' },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(formatToolUse(c.tool, c.input)).toBe(c.want);
    });
  }
});

describe('normalizeToolUse', () => {
  const normalize = (name: string, input?: Record<string, unknown>) =>
    normalizeToolUse(name, input);

  const cases: Array<{
    name: string;
    tool: string;
    input?: Record<string, unknown>;
    want: { tool: string; argSummary: string };
  }> = [
    { name: 'Read uses file_path', tool: 'Read', input: { file_path: '/a/b/main.go' }, want: { tool: 'Read', argSummary: '/a/b/main.go' } },
    { name: 'Write uses file_path', tool: 'Write', input: { file_path: 'x.ts' }, want: { tool: 'Write', argSummary: 'x.ts' } },
    { name: 'Edit uses file_path', tool: 'Edit', input: { file_path: 'y.ts' }, want: { tool: 'Edit', argSummary: 'y.ts' } },
    { name: 'Bash uses command truncated to 60', tool: 'Bash', input: { command: 'a'.repeat(80) }, want: { tool: 'Bash', argSummary: 'a'.repeat(60) } },
    { name: 'Grep uses pattern', tool: 'Grep', input: { pattern: 'func main' }, want: { tool: 'Grep', argSummary: 'func main' } },
    { name: 'Glob uses pattern', tool: 'Glob', input: { pattern: '**/*.ts' }, want: { tool: 'Glob', argSummary: '**/*.ts' } },
    { name: 'Task uses description', tool: 'Task', input: { description: 'fix the bug' }, want: { tool: 'Task', argSummary: 'fix the bug' } },
    { name: 'WebSearch uses query', tool: 'WebSearch', input: { query: 'pgx pooling' }, want: { tool: 'WebSearch', argSummary: 'pgx pooling' } },
    { name: 'WebFetch uses url', tool: 'WebFetch', input: { url: 'https://x.dev' }, want: { tool: 'WebFetch', argSummary: 'https://x.dev' } },
    { name: 'TodoWrite has empty arg', tool: 'TodoWrite', input: {}, want: { tool: 'TodoWrite', argSummary: '' } },
    { name: 'missing input yields empty arg', tool: 'Read', input: undefined, want: { tool: 'Read', argSummary: '' } },
    { name: 'non-string input yields empty arg', tool: 'Bash', input: { command: 123 }, want: { tool: 'Bash', argSummary: '' } },
    { name: 'unknown tool passes name with empty arg', tool: 'CustomThing', input: { foo: 'bar' }, want: { tool: 'CustomThing', argSummary: '' } },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(normalize(c.tool, c.input)).toEqual(c.want);
    });
  }
});
