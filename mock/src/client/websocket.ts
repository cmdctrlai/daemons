import WebSocket from 'ws';
import { URL } from 'url';
import { CmdCtrlConfig, Credentials, MockConfig } from '../config/config';
import {
  ServerMessage,
  DaemonMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  SessionActivityMessage,
  VersionStatusMessage
} from './messages';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MockGenerator, MockEvent } from '../mock/generator';
import {
  initSessionFile,
  appendAssistantMessage,
  appendUserMessage,
  readSessionMessages,
  getLastMessage,
  getSessionFilePath,
  sessionExists
} from '../mock/session-file';

const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;
const PING_INTERVAL = 30000;
const MAX_AUTH_FAILURES = 5; // give up after this many consecutive 401s

interface WatchedSession {
  sessionId: string;
  filePath: string;
  lastMessageCount: number;
  timer: NodeJS.Timeout;
}

export class MockDaemonClient {
  private ws: WebSocket | null = null;
  private config: CmdCtrlConfig;
  private credentials: Credentials;
  private mockConfig: MockConfig;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private consecutiveAuthFailures = 0;
  private generator: MockGenerator;
  private watchedSessions: Map<string, WatchedSession> = new Map();

  constructor(
    config: CmdCtrlConfig,
    credentials: Credentials,
    mockConfig: Partial<MockConfig> = {}
  ) {
    this.config = config;
    this.credentials = credentials;
    this.mockConfig = mockConfig as MockConfig;
    this.generator = new MockGenerator(mockConfig);
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
        try {
          const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
          daemonVersion = pkg.version;
        } catch { /* use default */ }
      }

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.credentials.refreshToken}`,
          'X-Device-ID': this.config.deviceId,
          'X-Agent-Type': 'mock',
          'X-Daemon-Version': daemonVersion,
        }
      });

      let wasOpen = false;

      this.ws.on('open', () => {
        wasOpen = true;
        console.log('WebSocket connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.consecutiveAuthFailures = 0;
        this.startPingInterval();
        this.sendStatus();
        // Mock daemon doesn't discover external sessions
        this.send({ type: 'report_sessions', sessions: [] });
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        this.stopPingInterval();
        if (wasOpen) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          this.consecutiveAuthFailures++;
          if (this.consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
            console.error('Authentication failed (401). Device may have been removed from the server.');
            console.error('Run "cmdctrl-mock register" again to re-register this device.');
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
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
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
    this.generator.stopAll();
    this.unwatchAllSessions();

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
      if (message.type !== 'pong') {
        console.log(`[WS OUT] ${message.type}:`, json.length > 200 ? json.substring(0, 200) + '...' : json);
      }
      this.ws.send(json);
    }
  }

  /**
   * Send an event for a task
   */
  private sendEvent(taskId: string, eventType: string, data: Record<string, unknown>): void {
    // SESSION_STARTED: auto-watch the session locally AND send to server
    // The server needs SESSION_STARTED to resolve PENDING session IDs early,
    // before TASK_COMPLETE arrives. Without this, session_id_changed and
    // agent_message arrive simultaneously, causing a race condition where
    // the frontend's incremental reload wins over the full reload and
    // drops the user message.
    if (eventType === 'SESSION_STARTED') {
      const sessionId = data.session_id as string;
      if (sessionId) {
        const filePath = getSessionFilePath(sessionId);
        if (sessionExists(sessionId)) {
          console.log(`[Mock] Auto-watching session ${sessionId}`);
          this.watchSession(sessionId, filePath);
        } else {
          // File doesn't exist yet at SESSION_STARTED time – it hasn't been created.
          // Retry after short delays so session activity streams during first message execution.
          const self = this;
          const retryDelays = [500, 1000, 2000, 4000];
          let attempt = 0;
          const retry = () => {
            if (attempt >= retryDelays.length) return;
            setTimeout(() => {
              if (sessionExists(sessionId)) {
                console.log(`[Mock] Auto-watching session ${sessionId} after ${retryDelays[attempt]}ms retry`);
                self.watchSession(sessionId, filePath);
              } else {
                attempt++;
                retry();
              }
            }, retryDelays[attempt]);
          };
          retry();
        }
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
      running_tasks: this.generator.getRunningTasks()
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
    console.log(`[Mock] Starting task ${msg.task_id}: ${msg.instruction.substring(0, 50)}...`);

    try {
      // Run the mock generator
      const events = this.generator.runTask(msg.task_id, msg.instruction, msg.project_path);

      let sessionId: string | undefined;
      let resultContent: string | undefined;

      for await (const event of events) {
        this.sendEvent(msg.task_id, event.eventType, event.data);

        // Track session ID for file creation
        if (event.eventType === 'SESSION_STARTED') {
          sessionId = event.data.session_id as string;
          // Create session file with user message
          initSessionFile(sessionId, msg.instruction);
        }

        // Track result for appending to file
        if (event.eventType === 'TASK_COMPLETE' || event.eventType === 'WAIT_FOR_USER') {
          resultContent = (event.data.result || event.data.prompt || event.data.context) as string;
        }
      }

      // Append assistant message to session file
      if (sessionId && resultContent) {
        appendAssistantMessage(sessionId, resultContent);
      }

    } catch (err) {
      console.error(`[Mock] Failed to start task ${msg.task_id}:`, err);
      this.sendEvent(msg.task_id, 'ERROR', {
        error: (err as Error).message
      });
    }
  }

  /**
   * Handle task_resume message
   */
  private async handleTaskResume(msg: TaskResumeMessage): Promise<void> {
    console.log(`[Mock] Resuming task ${msg.task_id} with session ${msg.session_id}`);

    try {
      // Add user message to session file
      appendUserMessage(msg.session_id, msg.message);

      // Run the mock generator for resume
      const events = this.generator.resumeTask(
        msg.task_id,
        msg.session_id,
        msg.message,
        msg.project_path
      );

      let resultContent: string | undefined;

      for await (const event of events) {
        this.sendEvent(msg.task_id, event.eventType, event.data);

        if (event.eventType === 'TASK_COMPLETE' || event.eventType === 'WAIT_FOR_USER') {
          resultContent = (event.data.result || event.data.prompt || event.data.context) as string;
        }
      }

      // Append assistant response to session file
      if (resultContent) {
        appendAssistantMessage(msg.session_id, resultContent);
      }

    } catch (err) {
      console.error(`[Mock] Failed to resume task ${msg.task_id}:`, err);
      this.sendEvent(msg.task_id, 'ERROR', {
        error: (err as Error).message
      });
    }
  }

  /**
   * Handle task_cancel message
   */
  private handleTaskCancel(msg: TaskCancelMessage): void {
    console.log(`[Mock] Cancelling task ${msg.task_id}`);
    this.generator.cancelTask(msg.task_id);
  }

  /**
   * Handle get_messages request
   */
  private handleGetMessages(msg: GetMessagesMessage): void {
    console.log(`[Mock] Getting messages for session ${msg.session_id}, limit=${msg.limit}`);

    try {
      const result = readSessionMessages(
        msg.session_id,
        msg.limit,
        msg.before_uuid,
        msg.after_uuid
      );

      this.send({
        type: 'messages',
        request_id: msg.request_id,
        session_id: msg.session_id,
        messages: result.messages,
        has_more: result.hasMore,
        oldest_uuid: result.oldestUuid,
        newest_uuid: result.newestUuid
      });

      console.log(`[Mock] Sent ${result.messages.length} messages`);
    } catch (err) {
      console.error(`[Mock] Failed to get messages:`, err);
      this.send({
        type: 'messages',
        request_id: msg.request_id,
        session_id: msg.session_id,
        messages: [],
        has_more: false,
        error: (err as Error).message
      });
    }
  }

  /**
   * Handle watch_session request
   */
  private handleWatchSession(msg: WatchSessionMessage): void {
    console.log(`[Mock] Starting watch for session ${msg.session_id}`);
    this.watchSession(msg.session_id, msg.file_path);
  }

  /**
   * Watch a session for changes
   */
  private watchSession(sessionId: string, filePath: string): void {
    // Already watching?
    if (this.watchedSessions.has(sessionId)) {
      return;
    }

    const lastInfo = getLastMessage(sessionId);
    const lastMessageCount = lastInfo?.messageCount || 0;

    // Poll every 500ms
    const timer = setInterval(() => {
      const info = getLastMessage(sessionId);
      if (!info) return;

      const watched = this.watchedSessions.get(sessionId);
      if (!watched) return;

      if (info.messageCount > watched.lastMessageCount) {
        // New activity
        watched.lastMessageCount = info.messageCount;

        const activity: SessionActivityMessage = {
          type: 'session_activity',
          session_id: sessionId,
          file_path: filePath,
          last_message: info.content.substring(0, 200),
          message_count: info.messageCount,
          is_completion: info.isCompletion,
          user_message_uuid: info.userMessageUuid
        };

        console.log(`[Mock] Session activity: ${sessionId} msgs=${info.messageCount} userUuid=${info.userMessageUuid?.slice(-8) || 'none'}`);
        this.send(activity);
      }
    }, 500);

    this.watchedSessions.set(sessionId, {
      sessionId,
      filePath,
      lastMessageCount,
      timer
    });
  }

  /**
   * Handle unwatch_session request
   */
  private handleUnwatchSession(msg: UnwatchSessionMessage): void {
    console.log(`[Mock] Stopping watch for session ${msg.session_id}`);
    this.unwatchSession(msg.session_id);
  }

  /**
   * Stop watching a session
   */
  private unwatchSession(sessionId: string): void {
    const watched = this.watchedSessions.get(sessionId);
    if (watched) {
      clearInterval(watched.timer);
      this.watchedSessions.delete(sessionId);
    }
  }

  /**
   * Stop watching all sessions
   */
  private unwatchAllSessions(): void {
    for (const [sessionId] of this.watchedSessions) {
      this.unwatchSession(sessionId);
    }
  }

  /**
   * Handle version_status message from server
   */
  private handleVersionStatus(msg: VersionStatusMessage): void {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error(`  Run: cmdctrl-mock update`);
      if (msg.changelog_url) console.error(`  Changelog: ${msg.changelog_url}`);
      if (msg.message) console.error(`  ${msg.message}`);
      console.error('');
      this.shouldReconnect = false;
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn(`  Run: cmdctrl-mock update`);
      if (msg.changelog_url) console.warn(`  Changelog: ${msg.changelog_url}`);
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
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  /**
   * Start ping interval
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
}
