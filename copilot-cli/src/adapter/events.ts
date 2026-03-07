/**
 * Types for Copilot CLI session events.
 *
 * Copilot CLI stores session events as JSONL in:
 *   ~/.copilot/session-state/<uuid>/events.jsonl
 *
 * Event types:
 *   session.start           - Session metadata (sessionId, cwd)
 *   session.info            - Info messages (auth, mcp connection)
 *   user.message            - User input
 *   assistant.turn_start    - Agent turn begins
 *   assistant.message       - Agent response with optional tool requests
 *   tool.execution_start    - Tool execution begins
 *   tool.execution_complete - Tool execution completes
 *   assistant.turn_end      - Agent turn ends
 */

export interface CopilotSessionEvent {
  type: string;
  data: Record<string, unknown>;
  id: string;
  timestamp: string;
  parentId: string | null;
}
