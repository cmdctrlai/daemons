/**
 * How ACP tool calls and permission requests read in the app: a progress line
 * ("Running npm test"), and a question card the user can answer with a tap.
 */
import type { PermissionOption, ToolCallFields, ToolKind } from './acp/types';
import type { QuestionCard } from './transcript';

const TARGET_CHARS = 80;

const KIND_VERBS: Partial<Record<ToolKind, string>> = {
  read: 'Reading',
  edit: 'Editing',
  delete: 'Deleting',
  move: 'Moving',
  search: 'Searching',
  execute: 'Running',
  think: 'Thinking',
  fetch: 'Fetching',
  switch_mode: 'Switching mode',
};

/** Agents that report every tool as kind "other" still name it; the name says what it does. */
const NAME_VERBS: Record<string, string> = {
  bash: 'Running',
  shell: 'Running',
  run_shell_command: 'Running',
  read: 'Reading',
  read_file: 'Reading',
  write: 'Writing',
  write_file: 'Writing',
  edit: 'Editing',
  glob: 'Searching',
  grep: 'Searching',
  grep_search: 'Searching',
  web_fetch: 'Fetching',
  web_search: 'Searching',
};

/** The input fields that name what a tool acts on, most telling first. */
const TARGET_KEYS = ['command', 'cmd', 'file_path', 'filePath', 'path', 'pattern', 'url', 'query', 'description'];

export interface ToolLine {
  action: string;
  target: string;
}

/** A tool call as the app's progress line. */
export function describeTool(tool: ToolCallFields): ToolLine {
  const title = (tool.title ?? '').trim();
  const name = title.split(/[\s:]/)[0]?.toLowerCase() ?? '';
  const action = (tool.kind && KIND_VERBS[tool.kind]) || NAME_VERBS[name] || (title ? `Using ${clip(name || title)}` : 'Using a tool');
  return { action, target: clip(toolTarget(tool)) };
}

function toolTarget(tool: ToolCallFields): string {
  const input = tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput as Record<string, unknown> : {};
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const location = tool.locations?.find((l) => l?.path)?.path;
  if (location) return location;
  // A title that is more than the tool's own name ("Shell: npm test") already says it.
  const title = (tool.title ?? '').trim();
  return /[\s:]/.test(title) ? title : '';
}

/** The card for a permission request: what the agent wants to do, and its options. */
export function permissionCard(tool: ToolCallFields, options: PermissionOption[]): QuestionCard {
  const { action, target } = describeTool(tool);
  const what = target ? `${action} ${target}` : action;
  const input = tool.rawInput && typeof tool.rawInput === 'object' ? tool.rawInput as Record<string, unknown> : {};
  const why = typeof input.justification === 'string' ? input.justification.trim() : '';
  return {
    question: why ? `Allow: ${what}?\n\n${why}` : `Allow: ${what}?`,
    header: 'Permission',
    options: options.map((o) => ({ label: o.name })),
  };
}

const APPROVALS = new Set(['yes', 'y', 'allow', 'approve', 'ok', 'okay', 'sure']);
const ALWAYS = new Set(['always', 'allow always', 'always allow']);
const REJECTIONS = new Set(['no', 'n', 'deny', 'reject', 'decline']);

/**
 * The option a reply picks: a tapped label, or a plain yes or no typed instead.
 * Anything else is not a choice – the user is telling the agent something.
 */
export function chooseOption(options: PermissionOption[], reply: string): PermissionOption | undefined {
  const text = reply.trim().toLowerCase();
  const exact = options.find((o) => o.name.trim().toLowerCase() === text);
  if (exact) return exact;
  const word = text.replace(/[.!]+$/, '');
  const firstOf = (...kinds: PermissionOption['kind'][]) => {
    for (const kind of kinds) {
      const option = options.find((o) => o.kind === kind);
      if (option) return option;
    }
    return undefined;
  };
  if (ALWAYS.has(word)) return firstOf('allow_always', 'allow_once');
  if (APPROVALS.has(word)) return firstOf('allow_once', 'allow_always');
  if (REJECTIONS.has(word)) return firstOf('reject_once', 'reject_always');
  return undefined;
}

/** The option that declines, for a reply that answered with something else. */
export function rejectOption(options: PermissionOption[]): PermissionOption | undefined {
  return options.find((o) => o.kind === 'reject_once') ?? options.find((o) => o.kind === 'reject_always');
}

function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > TARGET_CHARS ? `${line.slice(0, TARGET_CHARS - 1)}…` : line;
}
