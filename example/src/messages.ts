/**
 * CmdCtrl Daemon Protocol - Message Type Definitions
 *
 * These types define the JSON messages exchanged between daemons and the
 * CmdCtrl server over WebSocket. See docs/daemon-protocol.md for the
 * full specification.
 */

// ============================================================
// Server → Daemon messages (the server sends these to you)
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

export interface VersionStatusMessage {
  type: 'version_status';
  status: 'current' | 'update_available' | 'update_required';
  your_version: string;
  min_version?: string;
  latest_version?: string;
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
  | VersionStatusMessage;

// ============================================================
// Daemon → Server messages (you send these to the server)
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

export interface ReportSessionsMessage {
  type: 'report_sessions';
  sessions: [];  // Empty for most custom daemons
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

export type DaemonMessage =
  | PongMessage
  | StatusMessage
  | EventMessage
  | ReportSessionsMessage
  | MessagesResponseMessage;
