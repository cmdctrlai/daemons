/**
 * CmdCtrl Daemon Protocol - Message Type Definitions
 *
 * Canonical type definitions for all messages exchanged between daemons
 * and the CmdCtrl server over WebSocket.
 *
 * See https://docs.cmd-ctrl.ai/daemon-protocol for the full specification.
 */

// ============================================================
// Server → Daemon messages
// ============================================================

export interface PingMessage {
  type: 'ping';
}

export interface TaskStartMessage {
  type: 'task_start';
  task_id: string;
  instruction: string;
  project_path?: string;
}

export interface TaskResumeMessage {
  type: 'task_resume';
  task_id: string;
  session_id: string;
  message: string;
  project_path?: string;
}

export interface TaskCancelMessage {
  type: 'task_cancel';
  task_id: string;
}

export interface GetMessagesMessage {
  type: 'get_messages';
  request_id: string;
  session_id: string;
  limit: number;
  before_uuid?: string;
  after_uuid?: string;
}

export interface WatchSessionMessage {
  type: 'watch_session';
  session_id: string;
  file_path: string;
}

export interface UnwatchSessionMessage {
  type: 'unwatch_session';
  session_id: string;
}

export interface ContextRequestMessage {
  type: 'context_request';
  request_id: string;
  session_id: string;
  include: {
    initial_prompt?: boolean;
    recent_messages?: number;
    last_tool_use?: boolean;
  };
}

export interface VersionStatusMessage {
  type: 'version_status';
  status: 'current' | 'update_available' | 'update_required';
  your_version: string;
  min_version?: string;
  recommended_version?: string;
  latest_version?: string;
  changelog_url?: string;
  message?: string;
}

export type ServerMessage =
  | PingMessage
  | TaskStartMessage
  | TaskResumeMessage
  | TaskCancelMessage
  | GetMessagesMessage
  | WatchSessionMessage
  | UnwatchSessionMessage
  | ContextRequestMessage
  | VersionStatusMessage;

// ============================================================
// Daemon → Server messages
// ============================================================

export interface PongMessage {
  type: 'pong';
}

export interface StatusMessage {
  type: 'status';
  running_tasks: string[];
}

export interface EventMessage {
  type: 'event';
  task_id: string;
  event_type: string;
  [key: string]: unknown;
}

export interface SessionInfo {
  session_id: string;
  slug: string;
  title: string;
  project: string;
  project_name: string;
  file_path: string;
  last_message: string;
  last_activity: string;
  is_active: boolean;
  message_count: number;
}

export interface ReportSessionsMessage {
  type: 'report_sessions';
  sessions: SessionInfo[];
}

export interface MessageEntry {
  uuid: string;
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  timestamp: string;
}

export interface MessagesResponseMessage {
  type: 'messages';
  request_id: string;
  session_id: string;
  messages: MessageEntry[];
  has_more: boolean;
  oldest_uuid?: string;
  newest_uuid?: string;
  error?: string;
}

export interface SessionActivityMessage {
  type: 'session_activity';
  session_id: string;
  file_path: string;
  last_message: string;
  message_count: number;
  is_completion: boolean;
  user_message_uuid?: string;
  last_activity: string;
}

export type SessionStatus = 'working' | 'waiting_for_input' | 'completed' | 'errored' | 'stale';

export interface ContextResponseMessage {
  type: 'context_response';
  request_id: string;
  session_id: string;
  context: {
    title: string;
    project_path: string;
    initial_prompt?: string;
    recent_messages?: Array<{
      role: 'USER' | 'AGENT';
      content: string;
    }>;
    last_tool_use?: string;
    message_count: number;
    started_at?: string;
    last_activity_at: string;
    status: SessionStatus;
    status_detail?: string;
  };
  error?: string;
}

export type DaemonMessage =
  | PongMessage
  | StatusMessage
  | EventMessage
  | ReportSessionsMessage
  | MessagesResponseMessage
  | SessionActivityMessage
  | ContextResponseMessage;

// ============================================================
// Event types (used in EventMessage.event_type)
// ============================================================

export type EventType =
  | 'SESSION_STARTED'
  | 'WAIT_FOR_USER'
  | 'TASK_COMPLETE'
  | 'OUTPUT'
  | 'PROGRESS'
  | 'ERROR'
  | 'AGENT_RESPONSE'
  | 'VERBOSE'
  | 'USER_MESSAGE';
