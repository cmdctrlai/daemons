/**
 * Types for Gemini CLI stream-json output.
 *
 * Gemini CLI's --output-format stream-json emits NDJSON events:
 *   init         - Session metadata (session_id, model)
 *   message      - User and assistant message chunks
 *   tool_use     - Tool call requests with arguments
 *   tool_result  - Output from executed tools
 *   error        - Non-fatal warnings and system errors
 *   result       - Final outcome with aggregated statistics
 */

export interface GeminiStreamEvent {
  type: 'init' | 'message' | 'tool_use' | 'tool_result' | 'error' | 'result';
  timestamp?: string;
  // init fields
  session_id?: string;
  model?: string;
  // message fields
  role?: 'user' | 'assistant';
  content?: string;
  // tool_use fields
  tool_name?: string;
  tool_id?: string;
  parameters?: Record<string, unknown>;
  // tool_result fields
  status?: 'success' | 'error';
  output?: string;
  // error fields
  message?: string;
  // result fields
  response?: string;
  stats?: Record<string, unknown>;
}

export interface ProgressInfo {
  action: string;
  target: string;
}

/**
 * Extract progress info from a Gemini tool_use event.
 */
export function extractProgressFromToolUse(
  toolName: string,
  parameters: Record<string, unknown> | undefined
): ProgressInfo | null {
  if (!parameters) return null;

  // Gemini CLI uses similar built-in tools
  switch (toolName) {
    case 'ReadFile':
    case 'read_file':
      return { action: 'Reading', target: (parameters.path as string) || 'file' };
    case 'WriteFile':
    case 'write_file':
      return { action: 'Writing', target: (parameters.path as string) || 'file' };
    case 'EditFile':
    case 'edit_file':
      return { action: 'Editing', target: (parameters.path as string) || 'file' };
    case 'Shell':
    case 'shell':
    case 'Bash':
      const cmd = String(parameters.command || '').substring(0, 40);
      return { action: 'Running', target: cmd };
    case 'GlobTool':
    case 'glob':
    case 'ListDirectory':
    case 'list_directory':
      return { action: 'Searching', target: (parameters.pattern as string) || (parameters.path as string) || 'files' };
    case 'SearchFiles':
    case 'GrepTool':
    case 'grep':
      return { action: 'Searching', target: (parameters.pattern as string) || (parameters.query as string) || 'pattern' };
    case 'GoogleSearch':
    case 'WebSearch':
    case 'google_search':
      return { action: 'Searching web', target: (parameters.query as string) || '' };
    case 'WebFetch':
    case 'web_fetch':
      return { action: 'Fetching', target: (parameters.url as string) || 'URL' };
    default:
      // Generic tool use
      return { action: toolName, target: '' };
  }
}
