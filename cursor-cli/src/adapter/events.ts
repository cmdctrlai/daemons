/**
 * Types for Cursor CLI (cursor-agent) stream-json output.
 *
 * cursor-agent --output-format stream-json emits NDJSON events:
 *   system    (subtype: init)      - Session metadata (session_id, model, cwd)
 *   user                           - Echo of user message
 *   thinking  (subtype: delta)     - Streaming thinking text chunks
 *   thinking  (subtype: completed) - Thinking finished
 *   assistant                      - Assistant response message
 *   tool_call                      - Tool invocation (file edit, shell, etc.)
 *   tool_result                    - Tool execution result
 *   result    (subtype: success)   - Final result with aggregated response
 *   result    (subtype: error)     - Error result
 */

export interface StreamEvent {
  type: 'system' | 'user' | 'thinking' | 'assistant' | 'tool_call' | 'tool_result' | 'result';
  subtype?: string;
  session_id?: string;
  timestamp_ms?: number;
  // system init fields
  model?: string;
  cwd?: string;
  apiKeySource?: string;
  permissionMode?: string;
  // thinking delta fields
  text?: string;
  // assistant fields
  message?: {
    role: string;
    content: Array<{ type: string; text?: string }>;
  };
  // tool_call fields
  tool_name?: string;
  tool_call_id?: string;
  parameters?: Record<string, unknown>;
  // tool_result fields
  status?: string;
  output?: string;
  // result fields
  result?: string;
  duration_ms?: number;
  is_error?: boolean;
}

export interface ProgressInfo {
  action: string;
  target: string;
}

/**
 * Extract progress info from a tool_call event.
 */
export function extractProgressFromToolCall(event: StreamEvent): ProgressInfo | null {
  if (event.type !== 'tool_call' || !event.tool_name) return null;

  const params = event.parameters || {};

  switch (event.tool_name) {
    case 'file_read':
    case 'ReadFile':
    case 'read_file':
      return { action: 'Reading', target: (params.path as string) || 'file' };
    case 'file_write':
    case 'WriteFile':
    case 'write_file':
      return { action: 'Writing', target: (params.path as string) || 'file' };
    case 'file_edit':
    case 'EditFile':
    case 'edit_file':
      return { action: 'Editing', target: (params.path as string) || 'file' };
    case 'shell':
    case 'terminal':
    case 'Shell':
    case 'Bash': {
      const cmd = String(params.command || '').substring(0, 40);
      return { action: 'Running', target: cmd };
    }
    case 'search':
    case 'grep':
    case 'GrepTool':
    case 'SearchFiles':
      return { action: 'Searching', target: (params.pattern as string) || (params.query as string) || 'files' };
    case 'list_directory':
    case 'GlobTool':
    case 'glob':
      return { action: 'Searching', target: (params.pattern as string) || (params.path as string) || 'files' };
    default:
      return { action: event.tool_name, target: '' };
  }
}
