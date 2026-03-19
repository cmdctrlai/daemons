/**
 * CmdCtrl Daemon Client
 *
 * Base WebSocket client that handles the CmdCtrl daemon protocol:
 * - Connection management with automatic reconnection
 * - Ping/pong heartbeat
 * - Status reporting
 * - Message routing to user-provided handlers
 *
 * @example
 * ```typescript
 * const client = new DaemonClient({
 *   serverUrl: 'https://app.cmd-ctrl.ai',
 *   deviceId: 'device-123',
 *   agentType: 'my_agent',
 *   token: 'refresh-token',
 *   version: '1.0.0',
 * });
 *
 * client.onTaskStart(async (task) => {
 *   task.sessionStarted('my-session-id');
 *   task.progress('Thinking', '');
 *   const result = await myAgent.run(task.instruction);
 *   task.complete(result);
 * });
 *
 * client.onTaskResume(async (task) => {
 *   const result = await myAgent.resume(task.sessionId, task.message);
 *   task.complete(result);
 * });
 *
 * client.onGetMessages((req) => {
 *   return myStore.getMessages(req.sessionId, req.limit);
 * });
 *
 * await client.connect();
 * ```
 */

import WebSocket from 'ws';
import { URL } from 'url';
import {
  ServerMessage,
  DaemonMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  ContextRequestMessage,
  VersionStatusMessage,
  MessageEntry,
  SessionInfo,
  SessionStatus,
} from './messages';

// ============================================================
// Configuration
// ============================================================

export interface DaemonClientOptions {
  /** CmdCtrl server URL (e.g., "https://app.cmd-ctrl.ai") */
  serverUrl: string;
  /** Device ID from registration */
  deviceId: string;
  /** Your agent type identifier (snake_case, e.g., "my_agent") */
  agentType: string;
  /** Refresh token from registration */
  token: string;
  /** Your daemon's semantic version (e.g., "1.0.0") */
  version: string;
  /** Maximum reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number;
  /** Ping interval in ms (default: 30000) */
  pingInterval?: number;
}

// ============================================================
// Task handles (passed to user callbacks)
// ============================================================

/** Handle for a new task (from task_start). */
export interface TaskHandle {
  /** The canonical task/session ID */
  taskId: string;
  /** The user's instruction */
  instruction: string;
  /** Optional project path hint */
  projectPath?: string;

  /** Tell the server your native session ID. Must be called first. */
  sessionStarted(nativeSessionId: string): void;
  /** Report progress (shown as status in the UI) */
  progress(action: string, target: string): void;
  /** Send verbose output (shown in expanded view) */
  output(text: string, userMessageUuid?: string): void;
  /** Complete the task with a result */
  complete(result: string, userMessageUuid?: string): void;
  /** Ask the user a question (session becomes "awaiting reply") */
  waitForUser(prompt: string, result: string, options?: Array<{ label: string }>): void;
  /** Report an error */
  error(message: string): void;
}

/** Handle for a resumed task (from task_resume). */
export interface ResumeHandle {
  /** The canonical task/session ID */
  taskId: string;
  /** Your native session ID */
  sessionId: string;
  /** The user's follow-up message */
  message: string;
  /** Optional project path hint */
  projectPath?: string;

  /** Report progress */
  progress(action: string, target: string): void;
  /** Send verbose output */
  output(text: string, userMessageUuid?: string): void;
  /** Complete the task */
  complete(result: string, userMessageUuid?: string): void;
  /** Ask the user a question */
  waitForUser(prompt: string, result: string, options?: Array<{ label: string }>): void;
  /** Report an error */
  error(message: string): void;
}

/** Request for message history. */
export interface GetMessagesRequest {
  requestId: string;
  sessionId: string;
  limit: number;
  beforeUuid?: string;
  afterUuid?: string;
}

/** Response for message history. */
export interface GetMessagesResponse {
  messages: MessageEntry[];
  hasMore: boolean;
  oldestUuid?: string;
  newestUuid?: string;
  error?: string;
}

/** Context request for dashboard summaries. */
export interface ContextRequest {
  requestId: string;
  sessionId: string;
  includeInitialPrompt?: boolean;
  recentMessagesCount?: number;
  includeLastToolUse?: boolean;
}

/** Context response for dashboard summaries. */
export interface ContextResponse {
  title: string;
  projectPath: string;
  initialPrompt?: string;
  recentMessages?: Array<{ role: 'USER' | 'AGENT'; content: string }>;
  lastToolUse?: string;
  messageCount: number;
  startedAt?: string;
  lastActivityAt: string;
  status: SessionStatus;
  statusDetail?: string;
}

// ============================================================
// Handler types
// ============================================================

type TaskStartHandler = (task: TaskHandle) => Promise<void> | void;
type TaskResumeHandler = (task: ResumeHandle) => Promise<void> | void;
type TaskCancelHandler = (taskId: string) => void;
type GetMessagesHandler = (req: GetMessagesRequest) => GetMessagesResponse | Promise<GetMessagesResponse>;
type WatchSessionHandler = (sessionId: string, filePath: string) => void;
type UnwatchSessionHandler = (sessionId: string) => void;
type ContextRequestHandler = (req: ContextRequest) => ContextResponse | null | Promise<ContextResponse | null>;
type VersionStatusHandler = (status: VersionStatusMessage) => void;
type AuthFailureHandler = () => void;
type SessionsProvider = () => SessionInfo[] | Promise<SessionInfo[]>;

// ============================================================
// Client
// ============================================================

export class DaemonClient {
  private ws: WebSocket | null = null;
  private options: Required<DaemonClientOptions>;
  private reconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private sessionRefreshTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private consecutiveAuthFailures = 0;
  private readonly maxAuthFailures = 5; // give up after this many consecutive 401s
  private runningTasks: Set<string> = new Set();

  // User-provided handlers
  private taskStartHandler?: TaskStartHandler;
  private taskResumeHandler?: TaskResumeHandler;
  private taskCancelHandler?: TaskCancelHandler;
  private getMessagesHandler?: GetMessagesHandler;
  private watchSessionHandler?: WatchSessionHandler;
  private unwatchSessionHandler?: UnwatchSessionHandler;
  private contextRequestHandler?: ContextRequestHandler;
  private versionStatusHandler?: VersionStatusHandler;
  private authFailureHandler?: AuthFailureHandler;
  private sessionsProvider?: SessionsProvider;

  constructor(options: DaemonClientOptions) {
    this.options = {
      maxReconnectDelay: 30000,
      pingInterval: 30000,
      ...options,
    };
    this.reconnectDelay = 1000;
  }

  // ------------------------------------------------------------------
  // Handler registration
  // ------------------------------------------------------------------

  /** Register handler for new tasks. Required. */
  onTaskStart(handler: TaskStartHandler): this {
    this.taskStartHandler = handler;
    return this;
  }

  /** Register handler for task follow-ups. Required. */
  onTaskResume(handler: TaskResumeHandler): this {
    this.taskResumeHandler = handler;
    return this;
  }

  /** Register handler for task cancellation. */
  onTaskCancel(handler: TaskCancelHandler): this {
    this.taskCancelHandler = handler;
    return this;
  }

  /** Register handler for message history requests. Required. */
  onGetMessages(handler: GetMessagesHandler): this {
    this.getMessagesHandler = handler;
    return this;
  }

  /** Register handler for session watch requests. Optional. */
  onWatchSession(handler: WatchSessionHandler): this {
    this.watchSessionHandler = handler;
    return this;
  }

  /** Register handler for session unwatch requests. Optional. */
  onUnwatchSession(handler: UnwatchSessionHandler): this {
    this.unwatchSessionHandler = handler;
    return this;
  }

  /** Register handler for context requests. Optional. */
  onContextRequest(handler: ContextRequestHandler): this {
    this.contextRequestHandler = handler;
    return this;
  }

  /** Register handler for version status messages. Optional. */
  onVersionStatus(handler: VersionStatusHandler): this {
    this.versionStatusHandler = handler;
    return this;
  }

  /**
   * Register handler for authentication failures (HTTP 401 on connect).
   * Called when the server rejects the device credentials, typically because
   * the device was removed. If not set, defaults to process.exit(1).
   */
  onAuthFailure(handler: AuthFailureHandler): this {
    this.authFailureHandler = handler;
    return this;
  }

  /** Register a provider for external session discovery. Optional. */
  setSessionsProvider(provider: SessionsProvider): this {
    this.sessionsProvider = provider;
    return this;
  }

  // ------------------------------------------------------------------
  // Connection
  // ------------------------------------------------------------------

  /** Connect to the CmdCtrl server. Resolves when connected. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const serverUrl = new URL(this.options.serverUrl);
      const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${serverUrl.host}/ws/daemon`;

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'X-Device-ID': this.options.deviceId,
          'X-Agent-Type': this.options.agentType,
          'X-Daemon-Version': this.options.version,
        }
      });

      this.ws.on('open', async () => {
        this.reconnectDelay = 1000;
        this.consecutiveAuthFailures = 0;
        this.startPingInterval();
        this.startSessionRefreshInterval();
        this.sendStatus();
        await this.reportSessions();
        resolve();
      });

      this.ws.on('message', (data) => this.handleMessage(data.toString()));

      this.ws.on('close', () => {
        this.stopPingInterval();
        this.stopSessionRefreshInterval();
        this.scheduleReconnect();
      });

      this.ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          this.consecutiveAuthFailures++;
          if (this.consecutiveAuthFailures >= this.maxAuthFailures) {
            console.error('Authentication failed (401). Device may have been removed from the server.');
            console.error('Run the "register" command again to re-register this device.');
            this.shouldReconnect = false;
            if (this.authFailureHandler) {
              this.authFailureHandler();
            } else {
              process.exit(1);
            }
          }
          console.warn(`Authentication failed (401), retrying... (${this.consecutiveAuthFailures}/${this.maxAuthFailures})`);
          reject(new Error('Authentication failed (401)'));
          return;
        }
        reject(new Error(`Unexpected server response: ${res.statusCode}`));
      });

      this.ws.on('error', (err) => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.terminate();
        }
      });
    });
  }

  /** Disconnect from the server. */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPingInterval();
    this.stopSessionRefreshInterval();
    if (this.ws) {
      this.ws.close(1000, 'Daemon shutting down');
      this.ws = null;
    }
  }

  // ------------------------------------------------------------------
  // Public utilities
  // ------------------------------------------------------------------

  /** Send a session_activity message (for watched session updates). */
  sendSessionActivity(
    sessionId: string,
    filePath: string,
    lastMessage: string,
    messageCount: number,
    isCompletion: boolean,
    lastActivity?: string,
    userMessageUuid?: string
  ): void {
    this.send({
      type: 'session_activity',
      session_id: sessionId,
      file_path: filePath,
      last_message: lastMessage,
      message_count: messageCount,
      is_completion: isCompletion,
      user_message_uuid: userMessageUuid,
      last_activity: lastActivity || new Date().toISOString(),
    });
  }

  /** Report external sessions to the server. */
  async reportSessions(): Promise<void> {
    if (this.sessionsProvider) {
      const sessions = await this.sessionsProvider();
      this.send({ type: 'report_sessions', sessions });
    } else {
      this.send({ type: 'report_sessions', sessions: [] });
    }
  }

  // ------------------------------------------------------------------
  // Internal: message sending
  // ------------------------------------------------------------------

  private send(message: DaemonMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  sendEvent(taskId: string, eventType: string, data: Record<string, unknown> = {}): void {
    this.send({ type: 'event', task_id: taskId, event_type: eventType, ...data });
  }

  private sendStatus(): void {
    this.send({ type: 'status', running_tasks: Array.from(this.runningTasks) });
  }

  // ------------------------------------------------------------------
  // Internal: task handle factory
  // ------------------------------------------------------------------

  private createTaskHandle(taskId: string, msg: TaskStartMessage): TaskHandle {
    return {
      taskId,
      instruction: msg.instruction,
      projectPath: msg.project_path,
      sessionStarted: (id) => this.sendEvent(taskId, 'SESSION_STARTED', { session_id: id }),
      progress: (action, target) => this.sendEvent(taskId, 'PROGRESS', { action, target }),
      output: (text, uuid) => this.sendEvent(taskId, 'OUTPUT', { output: text, user_message_uuid: uuid }),
      complete: (result, uuid) => {
        this.sendEvent(taskId, 'TASK_COMPLETE', { result, user_message_uuid: uuid });
        this.runningTasks.delete(taskId);
        this.sendStatus();
      },
      waitForUser: (prompt, result, options) => {
        this.sendEvent(taskId, 'WAIT_FOR_USER', { prompt, result, options });
        this.runningTasks.delete(taskId);
        this.sendStatus();
      },
      error: (error) => {
        this.sendEvent(taskId, 'ERROR', { error });
        this.runningTasks.delete(taskId);
        this.sendStatus();
      },
    };
  }

  private createResumeHandle(taskId: string, msg: TaskResumeMessage): ResumeHandle {
    return {
      taskId,
      sessionId: msg.session_id,
      message: msg.message,
      projectPath: msg.project_path,
      progress: (action, target) => this.sendEvent(taskId, 'PROGRESS', { action, target }),
      output: (text, uuid) => this.sendEvent(taskId, 'OUTPUT', { output: text, user_message_uuid: uuid }),
      complete: (result, uuid) => {
        this.sendEvent(taskId, 'TASK_COMPLETE', { result, user_message_uuid: uuid });
        this.runningTasks.delete(taskId);
        this.sendStatus();
      },
      waitForUser: (prompt, result, options) => {
        this.sendEvent(taskId, 'WAIT_FOR_USER', { prompt, result, options });
        this.runningTasks.delete(taskId);
        this.sendStatus();
      },
      error: (error) => {
        this.sendEvent(taskId, 'ERROR', { error });
        this.runningTasks.delete(taskId);
        this.sendStatus();
      },
    };
  }

  // ------------------------------------------------------------------
  // Internal: message handling
  // ------------------------------------------------------------------

  private async handleMessage(raw: string): Promise<void> {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong' });
        break;

      case 'task_start': {
        if (!this.taskStartHandler) break;
        const m = msg as TaskStartMessage;
        this.runningTasks.add(m.task_id);
        this.sendStatus();
        try {
          await this.taskStartHandler(this.createTaskHandle(m.task_id, m));
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : 'Unknown error';
          this.sendEvent(m.task_id, 'ERROR', { error });
          this.runningTasks.delete(m.task_id);
          this.sendStatus();
        }
        break;
      }

      case 'task_resume': {
        if (!this.taskResumeHandler) break;
        const m = msg as TaskResumeMessage;
        this.runningTasks.add(m.task_id);
        this.sendStatus();
        try {
          await this.taskResumeHandler(this.createResumeHandle(m.task_id, m));
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : 'Unknown error';
          this.sendEvent(m.task_id, 'ERROR', { error });
          this.runningTasks.delete(m.task_id);
          this.sendStatus();
        }
        break;
      }

      case 'task_cancel': {
        const m = msg as TaskCancelMessage;
        this.runningTasks.delete(m.task_id);
        this.sendStatus();
        if (this.taskCancelHandler) this.taskCancelHandler(m.task_id);
        break;
      }

      case 'get_messages': {
        if (!this.getMessagesHandler) break;
        const m = msg as GetMessagesMessage;
        try {
          const result = await this.getMessagesHandler({
            requestId: m.request_id,
            sessionId: m.session_id,
            limit: m.limit,
            beforeUuid: m.before_uuid,
            afterUuid: m.after_uuid,
          });
          this.send({
            type: 'messages',
            request_id: m.request_id,
            session_id: m.session_id,
            messages: result.messages,
            has_more: result.hasMore,
            oldest_uuid: result.oldestUuid,
            newest_uuid: result.newestUuid,
            error: result.error,
          });
        } catch (err: unknown) {
          this.send({
            type: 'messages',
            request_id: m.request_id,
            session_id: m.session_id,
            messages: [],
            has_more: false,
            error: err instanceof Error ? err.message : 'Unknown error',
          });
        }
        break;
      }

      case 'watch_session': {
        const m = msg as WatchSessionMessage;
        if (this.watchSessionHandler) this.watchSessionHandler(m.session_id, m.file_path);
        break;
      }

      case 'unwatch_session': {
        const m = msg as UnwatchSessionMessage;
        if (this.unwatchSessionHandler) this.unwatchSessionHandler(m.session_id);
        break;
      }

      case 'context_request': {
        if (!this.contextRequestHandler) break;
        const m = msg as ContextRequestMessage;
        try {
          const ctx = await this.contextRequestHandler({
            requestId: m.request_id,
            sessionId: m.session_id,
            includeInitialPrompt: m.include.initial_prompt,
            recentMessagesCount: m.include.recent_messages,
            includeLastToolUse: m.include.last_tool_use,
          });
          if (ctx) {
            this.send({
              type: 'context_response',
              request_id: m.request_id,
              session_id: m.session_id,
              context: {
                title: ctx.title,
                project_path: ctx.projectPath,
                initial_prompt: ctx.initialPrompt,
                recent_messages: ctx.recentMessages,
                last_tool_use: ctx.lastToolUse,
                message_count: ctx.messageCount,
                started_at: ctx.startedAt,
                last_activity_at: ctx.lastActivityAt,
                status: ctx.status,
                status_detail: ctx.statusDetail,
              },
            });
          }
        } catch {
          // Context is optional; silently ignore errors
        }
        break;
      }

      case 'version_status': {
        const m = msg as VersionStatusMessage;
        if (this.versionStatusHandler) {
          this.versionStatusHandler(m);
        }
        if (m.status === 'update_required') {
          this.shouldReconnect = false;
          this.disconnect();
        }
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal: reconnection and keepalive
  // ------------------------------------------------------------------

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.maxReconnectDelay);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, this.options.pingInterval);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private startSessionRefreshInterval(): void {
    this.sessionRefreshTimer = setInterval(async () => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        await this.reportSessions();
      }
    }, 30000);
  }

  private stopSessionRefreshInterval(): void {
    if (this.sessionRefreshTimer) {
      clearInterval(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
  }
}
