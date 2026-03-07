/**
 * Types for Claude CLI stream-json output
 */

export interface StreamEvent {
  type: 'system' | 'assistant' | 'result' | 'user';
  subtype?: string;
  session_id?: string;
  message?: MessageContent;
  result?: string;
  permission_denials?: PermissionDenial[];
}

export interface MessageContent {
  content: ContentBlock[];
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result' | 'thinking';
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

export interface PermissionDenial {
  tool_name: string;
  id: string;
}

export interface AskUserInput {
  questions: Question[];
}

export interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface ProgressInfo {
  action: string;
  target: string;
}

/**
 * Format raw stream output into human-readable string for verbose display
 * Returns null if the event should be skipped
 */
export function formatVerboseOutput(line: string): string | null {
  try {
    const data = JSON.parse(line) as StreamEvent;

    if (data.type === 'system' && data.subtype === 'init') {
      return '● Task started';
    }

    if (data.type === 'assistant' && data.message?.content) {
      // Check for text content first
      const texts = data.message.content
        .filter(c => c.type === 'text' && c.text)
        .map(c => c.text!.substring(0, 100));
      if (texts.length > 0) {
        const joined = texts.join(' ');
        const truncated = joined.length > 80 ? joined.substring(0, 80) + '...' : joined;
        return `💬 ${truncated}`;
      }

      // Check for tool use
      const tools = data.message.content.filter(c => c.type === 'tool_use');
      if (tools.length > 0) {
        const tool = tools[0];
        const name = tool.name || 'unknown';
        const input = tool.input as Record<string, unknown> | undefined;

        switch (name) {
          case 'Read': return `📖 Reading ${input?.file_path || 'file'}`;
          case 'Write': return `✏️ Writing ${input?.file_path || 'file'}`;
          case 'Edit': return `🔧 Editing ${input?.file_path || 'file'}`;
          case 'Bash': {
            const cmd = String(input?.command || '').substring(0, 60);
            return `⚡ ${cmd}`;
          }
          case 'Glob': return `🔍 Searching: ${input?.pattern || ''}`;
          case 'Grep': return `🔎 Grepping: ${input?.pattern || ''}`;
          case 'Task': return `📋 Spawning agent`;
          case 'TodoWrite': return `📝 Updating todos`;
          case 'WebSearch': return `🌐 Searching: ${input?.query || ''}`;
          case 'WebFetch': return `🌐 Fetching: ${input?.url || ''}`;
          default: return `🔧 ${name}`;
        }
      }
    }

    if (data.type === 'result') {
      // Check for permission denials
      if (data.permission_denials?.length) {
        const denial = data.permission_denials[0];
        const toolName = denial.tool_name;
        if (toolName === 'AskUserQuestion') {
          return '❓ Waiting for your input';
        } else {
          return `⚠️ Permission required: ${toolName}`;
        }
      }
      return '✓ Completed';
    }

    // Skip uninteresting events
    return null;
  } catch {
    // Not JSON - show raw if short enough
    const trimmed = line.trim();
    if (trimmed && trimmed.length < 100) {
      return trimmed;
    }
    return null;
  }
}

/**
 * Extract progress info from tool use
 */
export function extractProgressFromToolUse(
  toolName: string,
  input: unknown
): ProgressInfo | null {
  const inputObj = input as Record<string, unknown>;

  switch (toolName) {
    case 'Read':
      return {
        action: 'Reading',
        target: (inputObj?.file_path as string) || 'file'
      };
    case 'Write':
      return {
        action: 'Writing',
        target: (inputObj?.file_path as string) || 'file'
      };
    case 'Edit':
      return {
        action: 'Editing',
        target: (inputObj?.file_path as string) || 'file'
      };
    case 'Bash':
      const cmd = (inputObj?.command as string) || '';
      return {
        action: 'Running',
        target: cmd.length > 30 ? cmd.substring(0, 30) + '...' : cmd
      };
    case 'Glob':
      return {
        action: 'Searching',
        target: (inputObj?.pattern as string) || 'files'
      };
    case 'Grep':
      return {
        action: 'Searching',
        target: (inputObj?.pattern as string) || 'pattern'
      };
    case 'WebSearch':
      return {
        action: 'Searching web',
        target: (inputObj?.query as string) || ''
      };
    case 'WebFetch':
      return {
        action: 'Fetching',
        target: (inputObj?.url as string) || 'URL'
      };
    case 'Task':
      return {
        action: 'Running agent',
        target: (inputObj?.description as string) || ''
      };
    default:
      return null;
  }
}
