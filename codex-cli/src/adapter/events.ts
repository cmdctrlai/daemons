/**
 * Types for Codex CLI `codex exec --json` JSONL output.
 *
 * Event types emitted by `codex exec --json`:
 *   thread.started   - Session metadata (thread_id)
 *   turn.started     - Agent turn begins
 *   turn.completed   - Agent turn finishes (includes token usage)
 *   turn.failed      - Agent turn encountered an error
 *   item.started     - An item (message, command, file change) started
 *   item.completed   - An item completed
 *   error            - An error occurred
 *
 * Item types within item.* events:
 *   agent_message, reasoning, command_execution, file_change,
 *   mcp_tool_call, web_search, plan_update
 */

export interface CodexThreadStartedEvent {
  type: 'thread.started';
  thread_id: string;
}

export interface CodexTurnStartedEvent {
  type: 'turn.started';
}

export interface CodexTurnCompletedEvent {
  type: 'turn.completed';
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface CodexTurnFailedEvent {
  type: 'turn.failed';
  error?: string;
}

export interface CodexItemEvent {
  type: 'item.started' | 'item.completed';
  item: CodexItem;
}

export interface CodexErrorEvent {
  type: 'error';
  message?: string;
  error?: string;
}

export type CodexStreamEvent =
  | CodexThreadStartedEvent
  | CodexTurnStartedEvent
  | CodexTurnCompletedEvent
  | CodexTurnFailedEvent
  | CodexItemEvent
  | CodexErrorEvent;

export interface CodexItem {
  id: string;
  type: CodexItemType;
  // agent_message fields
  content?: string;
  text?: string;
  // command_execution fields
  command?: string;
  exit_code?: number;
  output?: string;
  // file_change fields
  path?: string;
  action?: string;
  // reasoning fields
  summary?: string;
  // mcp_tool_call fields
  tool_name?: string;
  parameters?: Record<string, unknown>;
  result?: string;
  // web_search fields
  query?: string;
  // plan_update fields
  plan?: string;
}

export type CodexItemType =
  | 'agent_message'
  | 'reasoning'
  | 'command_execution'
  | 'file_change'
  | 'mcp_tool_call'
  | 'web_search'
  | 'plan_update';

export interface ProgressInfo {
  action: string;
  target: string;
}

/**
 * Extract progress info from a Codex item event.
 */
export function extractProgressFromItem(item: CodexItem): ProgressInfo | null {
  switch (item.type) {
    case 'command_execution':
      return {
        action: 'Running',
        target: (item.command || '').substring(0, 40),
      };
    case 'file_change':
      return {
        action: item.action === 'delete' ? 'Deleting' : item.action === 'create' ? 'Creating' : 'Editing',
        target: item.path || 'file',
      };
    case 'web_search':
      return {
        action: 'Searching web',
        target: item.query || '',
      };
    case 'mcp_tool_call':
      return {
        action: item.tool_name || 'Tool call',
        target: '',
      };
    case 'reasoning':
      return {
        action: 'Thinking',
        target: (item.summary || '').substring(0, 40),
      };
    case 'plan_update':
      return {
        action: 'Planning',
        target: '',
      };
    default:
      return null;
  }
}
