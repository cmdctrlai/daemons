import WebSocket from 'ws';
import { URL } from 'url';
import { CmdCtrlConfig, Credentials, writeCredentials } from '../config/config';
import { ClaudeAdapter } from '../adapter/claude-cli';
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
  SessionInfo,
} from './messages';
import { readFileSync } from 'fs';
import { join } from 'path';
import { SessionEvent, CompletionEvent } from '../session-watcher';
import { discoverSessions, ExternalSession } from '../session-discovery';
import { readMessages, findSessionFile } from '../message-reader';
import { SessionWatcher } from '../session-watcher';
import { buildContextResponse } from '../handlers/context-handler';
import { SessionActivityMessage } from './messages';

const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const PING_INTERVAL = 30000; // 30 seconds
const SESSION_REFRESH_INTERVAL = 30000; // 30 seconds
const MAX_AUTH_FAILURES = 5; // give up after this many consecutive 401s

export class DaemonClient {
  private ws: WebSocket | null = null;
  private config: CmdCtrlConfig;
  private credentials: Credentials;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private sessionRefreshTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private consecutiveAuthFailures = 0;
  private adapter: ClaudeAdapter;
  private managedSessionIds: Set<string> = new Set(); // Sessions managed by this daemon
  private lastReportedSessionCount = -1; // Track for change detection
  private sessionWatcher: SessionWatcher;

  constructor(config: CmdCtrlConfig, credentials: Credentials) {
    this.config = config;
    this.credentials = credentials;
    this.adapter = new ClaudeAdapter(this.sendEvent.bind(this));
    this.sessionWatcher = new SessionWatcher(
      this.handleSessionEvent.bind(this),
      this.handleSessionCompletion.bind(this)
    );
  }

  /**
   * Handle session events from the JSONL watcher and forward to server
   * Converts SessionEvent to EventMessage format
   */
  private handleSessionEvent(event: SessionEvent): void {
    // Send as an event message to the server
    this.send({
      type: 'event',
      task_id: '', // No task_id for watched session events (file-based, not daemon-spawned)
      event_type: event.type,
      session_id: event.sessionId,
      uuid: event.uuid,
      content: event.content,
      timestamp: event.timestamp,
    });
  }

  /**
   * Handle session completion events from the JSONL watcher
   * Sends session_activity message with is_completion=true to trigger push notifications
   */
  private handleSessionCompletion(event: CompletionEvent): void {
    console.log(`[WS] Sending session_activity completion for session ${event.sessionId.slice(-8)}`);

    const message: SessionActivityMessage = {
      type: 'session_activity',
      session_id: event.sessionId,
      file_path: event.filePath,
      last_message: event.lastMessage,
      message_count: event.messageCount,
      is_completion: true,
      last_activity: new Date().toISOString(),
    };

    this.send(message);
  }

  /**
   * Connect to the CmdCtrl server via WebSocket
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const serverUrl = new URL(this.config.serverUrl);
      const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${serverUrl.host}/ws/daemon`;

      console.log(`Connecting to ${wsUrl}...`);

      // Read version from package.json
      let daemonVersion = 'unknown';
      try {
        const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
        daemonVersion = pkg.version;
      } catch {
        // Fall back if package.json not found (development mode)
        try {
          const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
          daemonVersion = pkg.version;
        } catch {
          // Use default
        }
      }

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.credentials.refreshToken}`,
          'X-Device-ID': this.config.deviceId,
          'X-Daemon-Version': daemonVersion,
        }
      });

      this.ws.on('open', () => {
        console.log('WebSocket connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.consecutiveAuthFailures = 0;
        this.startPingInterval();
        this.startSessionRefreshInterval();
        this.sendStatus();
        this.reportSessions();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        this.stopPingInterval();
        this.stopSessionRefreshInterval();
        this.scheduleReconnect();
      });

      this.ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          this.consecutiveAuthFailures++;
          if (this.consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
            console.error('Authentication failed (401). Device may have been removed from the server.');
            console.error('Run "cmdctrl-claude-code register" again to re-register this device.');
            this.shouldReconnect = false;
            process.exit(1);
          }
          console.warn(`Authentication failed (401), retrying... (${this.consecutiveAuthFailures}/${MAX_AUTH_FAILURES})`);
          reject(new Error('Authentication failed (401)'));
          return;
        }
        reject(new Error(`Unexpected server response: ${res.statusCode}`));
      });

      this.ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.terminate();
        }
      });
    });
  }

  /**
   * Disconnect from server
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.stopPingInterval();
    this.stopSessionRefreshInterval();

    // Stop all running tasks
    await this.adapter.stopAll();

    // Stop all session watchers
    this.sessionWatcher.unwatchAll();

    if (this.ws) {
      this.ws.close(1000, 'Daemon shutting down');
      this.ws = null;
    }
  }

  /**
   * Send a message to the server
   */
  private send(message: DaemonMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(message);
      // Log all outgoing messages except pong (too noisy)
      if (message.type !== 'pong') {
        console.log(`[WS OUT] ${message.type}:`, json.length > 200 ? json.substring(0, 200) + '...' : json);
      }
      this.ws.send(json);
    }
  }

  /**
   * Send an event for a task
   */
  private sendEvent(
    taskId: string,
    eventType: string,
    data: Record<string, unknown>
  ): void {
    // Auto-watch session file when we learn the session_id
    // This enables unified notification path via session_activity
    const sessionId = data.session_id as string | undefined;
    if (sessionId) {
      const filePath = findSessionFile(sessionId);
      if (filePath) {
        console.log(`[WS] Auto-watching session ${sessionId} for unified notifications`);
        this.sessionWatcher.watchSession(sessionId, filePath);
      } else if (eventType === 'SESSION_STARTED') {
        // File doesn't exist yet at SESSION_STARTED time – Claude Code hasn't created it.
        // Retry after short delays so verbose output streams during first message execution.
        const watcher = this.sessionWatcher;
        const retryDelays = [500, 1000, 2000, 4000];
        let attempt = 0;
        const retry = () => {
          if (attempt >= retryDelays.length) return;
          setTimeout(() => {
            const fp = findSessionFile(sessionId);
            if (fp) {
              console.log(`[WS] Auto-watching session ${sessionId} after ${retryDelays[attempt]}ms retry`);
              watcher.watchSession(sessionId, fp);
            } else {
              attempt++;
              retry();
            }
          }, retryDelays[attempt]);
        };
        retry();
      }
    }

    this.send({
      type: 'event',
      task_id: taskId,
      event_type: eventType,
      ...data
    });
  }

  /**
   * Send current status to server
   */
  private sendStatus(): void {
    this.send({
      type: 'status',
      running_tasks: this.adapter.getRunningTasks()
    });
  }

  /**
   * Handle incoming message from server
   */
  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw) as ServerMessage;
    } catch {
      console.error('Failed to parse message:', raw);
      return;
    }

    // Log all incoming messages except ping (too noisy)
    if (msg.type !== 'ping') {
      console.log(`[WS IN] ${msg.type}:`, raw.length > 200 ? raw.substring(0, 200) + '...' : raw);
    }

    switch (msg.type) {
      case 'ping':
        this.send({ type: 'pong' });
        break;

      case 'task_start':
        this.handleTaskStart(msg as TaskStartMessage);
        break;

      case 'task_resume':
        this.handleTaskResume(msg as TaskResumeMessage);
        break;

      case 'task_cancel':
        this.handleTaskCancel(msg as TaskCancelMessage);
        break;

      case 'get_messages':
        this.handleGetMessages(msg as GetMessagesMessage);
        break;

      case 'watch_session':
        this.handleWatchSession(msg as WatchSessionMessage);
        break;

      case 'unwatch_session':
        this.handleUnwatchSession(msg as UnwatchSessionMessage);
        break;

      case 'context_request':
        this.handleContextRequest(msg as ContextRequestMessage);
        break;

      case 'version_status':
        this.handleVersionStatus(msg as VersionStatusMessage);
        break;

      default:
        console.warn('Unknown message type:', (msg as { type: string }).type);
    }
  }

  /**
   * Handle task_start message
   */
  private async handleTaskStart(msg: TaskStartMessage): Promise<void> {
    console.log(`Starting task ${msg.task_id}: ${msg.instruction.substring(0, 50)}...`);

    try {
      await this.adapter.startTask(msg.task_id, msg.instruction, msg.project_path);
    } catch (err) {
      console.error(`Failed to start task ${msg.task_id}:`, err);
      this.sendEvent(msg.task_id, 'ERROR', {
        error: (err as Error).message
      });
    }
  }

  /**
   * Handle task_resume message
   */
  private async handleTaskResume(msg: TaskResumeMessage): Promise<void> {
    console.log(`Resuming task ${msg.task_id} with session ${msg.session_id}`);

    try {
      await this.adapter.resumeTask(msg.task_id, msg.session_id, msg.message, msg.project_path);
    } catch (err) {
      console.error(`Failed to resume task ${msg.task_id}:`, err);
      this.sendEvent(msg.task_id, 'ERROR', {
        error: (err as Error).message
      });
    }
  }

  /**
   * Handle task_cancel message
   */
  private async handleTaskCancel(msg: TaskCancelMessage): Promise<void> {
    console.log(`Cancelling task ${msg.task_id}`);
    await this.adapter.cancelTask(msg.task_id);
  }

  /**
   * Handle get_messages request
   */
  private handleGetMessages(msg: GetMessagesMessage): void {
    console.log(`Getting messages for session ${msg.session_id}, limit=${msg.limit}, before=${msg.before_uuid || 'none'}, after=${msg.after_uuid || 'none'}`);

    try {
      const result = readMessages(msg.session_id, msg.limit, msg.before_uuid, msg.after_uuid);

      this.send({
        type: 'messages',
        request_id: msg.request_id,
        session_id: msg.session_id,
        messages: result.messages,
        has_more: result.hasMore,
        oldest_uuid: result.oldestUuid,
        newest_uuid: result.newestUuid,
      });

      console.log(`Sent ${result.messages.length} messages, has_more=${result.hasMore}`);
    } catch (err) {
      console.error(`Failed to get messages for session ${msg.session_id}:`, err);

      this.send({
        type: 'messages',
        request_id: msg.request_id,
        session_id: msg.session_id,
        messages: [],
        has_more: false,
        error: (err as Error).message,
      });
    }
  }

  /**
   * Handle watch_session request - start monitoring a session file for changes
   */
  private handleWatchSession(msg: WatchSessionMessage): void {
    console.log(`Starting to watch session ${msg.session_id} at ${msg.file_path}`);
    this.sessionWatcher.watchSession(msg.session_id, msg.file_path);
  }

  /**
   * Handle unwatch_session request - stop monitoring a session file
   */
  private handleUnwatchSession(msg: UnwatchSessionMessage): void {
    console.log(`Stopping watch for session ${msg.session_id}`);
    this.sessionWatcher.unwatchSession(msg.session_id);
  }

  /**
   * Handle context_request - extract session context for dashboard summaries
   */
  private handleContextRequest(msg: ContextRequestMessage): void {
    console.log(`Context request for session ${msg.session_id}`);

    const response = buildContextResponse(msg.request_id, msg.session_id, {
      includeInitialPrompt: msg.include.initial_prompt,
      recentMessagesCount: msg.include.recent_messages,
      includeLastToolUse: msg.include.last_tool_use,
    });

    this.send(response);

    if (response.error) {
      console.log(`Context request failed: ${response.error}`);
    } else {
      console.log(`Sent context for session ${msg.session_id}: status=${response.context.status}, messages=${response.context.message_count}`);
    }
  }

  /**
   * Handle version_status message from server
   */
  private handleVersionStatus(msg: VersionStatusMessage): void {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error(`  Run: cmdctrl-claude-code update`);
      if (msg.changelog_url) {
        console.error(`  Changelog: ${msg.changelog_url}`);
      }
      if (msg.message) {
        console.error(`  ${msg.message}`);
      }
      console.error('');
      this.shouldReconnect = false;
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn(`  Run: cmdctrl-claude-code update`);
      if (msg.changelog_url) {
        console.warn(`  Changelog: ${msg.changelog_url}`);
      }
      console.warn('');
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) {
      return;
    }

    console.log(`Reconnecting in ${this.reconnectDelay / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch {
        // Increase delay with exponential backoff
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          MAX_RECONNECT_DELAY
        );
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL);
  }

  /**
   * Stop ping interval
   */
  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Report discovered external sessions to server
   */
  private async reportSessions(): Promise<void> {
    try {
      // Discover sessions, excluding any we're currently managing
      const sessions = await discoverSessions(this.managedSessionIds);

      // Convert to SessionInfo format
      const sessionInfos: SessionInfo[] = sessions.map((s: ExternalSession) => ({
        session_id: s.session_id,
        slug: s.slug,
        title: s.title,
        project: s.project,
        project_name: s.project_name,
        file_path: s.file_path,
        last_message: s.last_message,
        last_activity: s.last_activity,
        is_active: s.is_active,
        message_count: s.message_count
      }));

      this.send({
        type: 'report_sessions',
        sessions: sessionInfos
      });

      console.log(`Reported ${sessionInfos.length} external sessions`);
    } catch (err) {
      console.error('Failed to report sessions:', err);
    }
  }

  /**
   * Start periodic session refresh
   */
  private startSessionRefreshInterval(): void {
    this.sessionRefreshTimer = setInterval(() => {
      this.reportSessions();
    }, SESSION_REFRESH_INTERVAL);
  }

  /**
   * Stop session refresh interval
   */
  private stopSessionRefreshInterval(): void {
    if (this.sessionRefreshTimer) {
      clearInterval(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
  }

  /**
   * Add a session ID to the managed set (sessions started via this daemon)
   */
  addManagedSession(sessionId: string): void {
    this.managedSessionIds.add(sessionId);
  }

  /**
   * Remove a session ID from the managed set
   */
  removeManagedSession(sessionId: string): void {
    this.managedSessionIds.delete(sessionId);
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshToken(): Promise<boolean> {
    // TODO: Implement token refresh
    // POST to server with refresh token, get new access token
    // Update credentials file
    console.log('Token refresh not yet implemented');
    return false;
  }
}
