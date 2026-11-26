/**
 * The slice of the Agent Client Protocol this daemon speaks, as plain types.
 * Built against protocol version 1, schema v1.28.0
 * (https://github.com/agentclientprotocol/agent-client-protocol/releases/tag/schema-v1.28.0).
 * Fields the daemon never reads are left out; everything an agent may omit is optional.
 */

export const PROTOCOL_VERSION = 1;

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  sessionCapabilities?: {
    list?: object | null;
    resume?: object | null;
    close?: object | null;
  };
}

export interface InitializeResponse {
  protocolVersion: number;
  agentCapabilities?: AgentCapabilities;
  agentInfo?: { name?: string; title?: string; version?: string } | null;
  authMethods?: Array<{ id: string; name: string; description?: string | null }>;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface ToolCallFields {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  rawInput?: unknown;
  locations?: Array<{ path: string; line?: number | null }> | null;
}

export type SessionUpdate =
  | { sessionUpdate: 'user_message_chunk' | 'agent_message_chunk' | 'agent_thought_chunk'; content: ContentBlock; messageId?: string | null }
  | ({ sessionUpdate: 'tool_call' | 'tool_call_update' } & ToolCallFields)
  | { sessionUpdate: 'plan'; entries?: Array<{ content: string; status?: string }> }
  | { sessionUpdate: 'session_info_update'; title?: string | null; updatedAt?: string | null }
  | { sessionUpdate: string; [key: string]: unknown };

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCallFields;
  options: PermissionOption[];
}

export type RequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse {
  stopReason: StopReason;
}

export interface AcpSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface ListSessionsResponse {
  sessions: AcpSessionInfo[];
  nextCursor?: string | null;
}
