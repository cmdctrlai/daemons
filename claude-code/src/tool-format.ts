/**
 * How a tool call is written for the verbose pane.
 *
 * The live stream and the replay of a finished turn both go through here, so a
 * tool call reads the same whether the client watched it happen or arrived
 * afterwards.
 */

/** One tool call as a single verbose line, e.g. "📖 Reading /tmp/x.ts". */
export function formatToolUse(name: string, input?: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `📖 Reading ${input?.file_path || 'file'}`;
    case 'Write':
      return `✏️ Writing ${input?.file_path || 'file'}`;
    case 'Edit':
      return `🔧 Editing ${input?.file_path || 'file'}`;
    case 'Bash': {
      const cmd = ((input?.command as string) || '').slice(0, 60);
      return `⚡ Running: ${cmd}`;
    }
    case 'Glob':
      return `🔍 Searching: ${input?.pattern || ''}`;
    case 'Grep':
      return `🔎 Grepping: ${input?.pattern || ''}`;
    case 'Task':
      return `📋 Spawning task: ${input?.description || 'subagent'}`;
    case 'TodoWrite':
      return `📝 Updating todos`;
    case 'WebSearch':
      return `🌐 Searching: ${input?.query || ''}`;
    case 'WebFetch':
      return `🌐 Fetching: ${input?.url || ''}`;
    case 'EnterPlanMode':
      return `📋 Entered plan mode`;
    case 'ExitPlanMode':
      return `📋 Plan ready for approval`;
    default:
      return `🔧 ${name}`;
  }
}

/**
 * Normalized descriptor for a tool call – the same argument extraction without
 * the emoji, so the server can narrate the action for voice mode across agents.
 */
export function normalizeToolUse(
  name: string,
  input?: Record<string, unknown>
): { tool: string; argSummary: string } {
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return { tool: name, argSummary: str(input?.file_path) };
    case 'Bash':
      return { tool: name, argSummary: str(input?.command).slice(0, 60) };
    case 'Glob':
    case 'Grep':
      return { tool: name, argSummary: str(input?.pattern) };
    case 'Task':
      return { tool: name, argSummary: str(input?.description) };
    case 'WebSearch':
      return { tool: name, argSummary: str(input?.query) };
    case 'WebFetch':
      return { tool: name, argSummary: str(input?.url) };
    case 'TodoWrite':
    case 'EnterPlanMode':
    case 'ExitPlanMode':
      return { tool: name, argSummary: '' };
    default:
      return { tool: name, argSummary: '' };
  }
}
