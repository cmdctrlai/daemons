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
  images?: string[];
}

export interface TaskResumeMessage {
  type: 'task_resume';
  task_id: string;
  session_id: string;
  message: string;
  project_path?: string;
  images?: string[];
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

/**
 * Asks the daemon to end whatever local process is holding a session, so the
 * user can drive it from CmdCtrl again. Only agents whose sessions can be
 * exclusively claimed by a local process implement this; the rest never
 * register a handler and the server hears nothing back.
 */
export interface ForceQuitSessionMessage {
  type: 'force_quit_session';
  request_id: string;
  session_id: string;
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
  | ForceQuitSessionMessage
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
  /**
   * Normalized tool descriptor for VERBOSE (tool-use) events. Lets the server
   * narrate tool actions uniformly across agents ("running the grep command")
   * without parsing each agent's verbose text. `tool` is the raw tool name and
   * `arg_summary` its key argument (a command, pattern, path, …) with no emoji.
   * Populated by claude-code first; other daemons may leave these empty until
   * they wire them through, in which case the server falls back to a generic phrase.
   */
  tool?: string;
  arg_summary?: string;
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
  /** Live value from Claude Code's /rename (scanned from ~/.claude/sessions/<pid>.json). Optional for backwards compatibility. */
  cli_user_title?: string;
}

export interface ReportSessionsMessage {
  type: 'report_sessions';
  sessions: SessionInfo[];
}

/** One slash command a daemon is willing to have autocompleted in the composer. */
export interface SlashCommandInfo {
  /** Command name without the leading slash, e.g. "compact". */
  name: string;
  /** Short human-readable summary. Omitted for commands the daemon knows only by name. */
  description?: string;
  /** Argument shape shown next to the name, e.g. "<title>". */
  usage_hint?: string;
}

/** The commands available to sessions running in one project directory. */
export interface SlashCommandSet {
  /** Absolute project path the set applies to. */
  project: string;
  commands: SlashCommandInfo[];
}

/**
 * Full replacement of everything the daemon currently knows about slash commands,
 * keyed by project. Sent on connect and whenever a set changes – not per session,
 * because the command set is a property of the project and the user's environment,
 * and repeating it inside every `report_sessions` tick would multiply an identical
 * payload by the session count.
 */
export interface ReportSlashCommandsMessage {
  type: 'report_slash_commands';
  sets: SlashCommandSet[];
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

/**
 * What became of a force_quit_session request.
 *
 * `released` means the holder is gone and the session is drivable now.
 * `not_held` means nothing was holding it, which is a success from the user's
 * point of view. `busy` means the holder is mid-turn and was deliberately left
 * alone; `foreign` means something we could not identify as the user's own
 * agent process holds it, and we will not signal that. `unknown_session` means
 * the agent has no such session on this machine, so there is nothing here that
 * force quit is entitled to touch. `shared` means one process is running this
 * session and others besides, so ending it would close work the user did not
 * ask about.
 */
export interface ForceQuitResultMessage {
  type: 'force_quit_result';
  request_id: string;
  session_id: string;
  status: 'released' | 'not_held' | 'busy' | 'foreign' | 'shared' | 'unknown_session' | 'failed';
  detail?: string;
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
  | ReportSlashCommandsMessage
  | MessagesResponseMessage
  | ForceQuitResultMessage
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
