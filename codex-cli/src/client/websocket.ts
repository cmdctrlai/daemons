import WebSocket from 'ws';
import { URL } from 'url';
import { CmdCtrlConfig, Credentials } from '../config/config';
import { CodexAdapter } from '../adapter/codex-cli';
import {
  ServerMessage,
  DaemonMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  VersionStatusMessage,
  SessionActivityMessage,
} from './messages';
import { readFileSync } from 'fs';
import { join } from 'path';
import { discoverSessions, readSessionMessages } from '../session-discovery';
import { CodexSessionWatcher, CodexSessionEvent, CodexCompletionEvent } from '../session-watcher';

const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;
const PING_INTERVAL = 30000;
const SESSION_REFRESH_INTERVAL = 30000; // 30 seconds

export class DaemonClient {
  private ws: WebSocket | null = null;
  private config: CmdCtrlConfig;
  private credentials: Credentials;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private sessionRefreshTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private adapter: CodexAdapter;
  private sessionWatcher: CodexSessionWatcher;
  // Session IDs managed by this daemon (started via task_start) — excluded from discovery
  private managedSessionIds: Set<string> = new Set();

  constructor(config: CmdCtrlConfig, credentials: Credentials) {
    this.config = config;
    this.credentials = credentials;
    this.adapter = new CodexAdapter(this.sendEvent.bind(this));
    this.sessionWatcher = new CodexSessionWatcher(
      this.handleSessionEvent.bind(this),
      this.handleSessionCompletion.bind(this),
    );
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const serverUrl = new URL(this.config.serverUrl);
      const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${serverUrl.host}/ws/daemon`;

      console.log(`Connecting to ${wsUrl}...`);

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
          'X-Agent-Type': 'codex_cli',
          'X-Daemon-Version': daemonVersion,
        }
      });

      let wasOpen = false;

      this.ws.on('open', () => {
        wasOpen = true;
        console.log('WebSocket connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.startPingInterval();
        this.sendStatus();
        this.reportSessions();
        this.startSessionRefreshInterval();
        resolve();
      });

      this.ws.on('message', (data) => this.handleMessage(data.toString()));

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        this.stopPingInterval();
        this.stopSessionRefreshInterval();
        if (wasOpen) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          console.error('Authentication failed (401). Device may have been removed from the server.');
          console.error('Run "cmdctrl-codex-cli register" again to re-register this device.');
          this.shouldReconnect = false;
          process.exit(1);
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

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingInterval();
    this.stopSessionRefreshInterval();
    this.sessionWatcher.unwatchAll();
    await this.adapter.stopAll();
    if (this.ws) {
      this.ws.close(1000, 'Daemon shutting down');
      this.ws = null;
    }
  }

  private send(message: DaemonMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(message);
      if (message.type !== 'pong') {
        console.log(`[WS OUT] ${message.type}:`, json.length > 200 ? json.substring(0, 200) + '...' : json);
      }
      this.ws.send(json);
    }
  }

  private sendEvent(
    taskId: string,
    eventType: string,
    data: Record<string, unknown>
  ): void {
    const sessionId = data.session_id as string | undefined;
    if (eventType === 'SESSION_STARTED' && sessionId) {
      this.managedSessionIds.add(sessionId);
    }

    this.send({
      type: 'event',
      task_id: taskId,
      event_type: eventType,
      ...data,
    });
  }

  private sendStatus(): void {
    this.send({
      type: 'status',
      running_tasks: this.adapter.getRunningTasks(),
    });
  }

  private reportSessions(): void {
    try {
      const sessions = discoverSessions(this.managedSessionIds);
      this.send({
        type: 'report_sessions',
        sessions,
      });
      console.log(`Reported ${sessions.length} external sessions`);
    } catch (err) {
      console.error('Failed to report sessions:', err);
    }
  }

  private startSessionRefreshInterval(): void {
    this.sessionRefreshTimer = setInterval(() => {
      this.reportSessions();
    }, SESSION_REFRESH_INTERVAL);
  }

  private stopSessionRefreshInterval(): void {
    if (this.sessionRefreshTimer) {
      clearInterval(this.sessionRefreshTimer);
      this.sessionRefreshTimer = null;
    }
  }

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
        break;
    }
  }

  private async handleTaskStart(msg: TaskStartMessage): Promise<void> {
    console.log(`Starting task ${msg.task_id}: ${msg.instruction.substring(0, 50)}...`);
    try {
      await this.adapter.startTask(msg.task_id, msg.instruction, msg.project_path);
    } catch (err) {
      console.error(`Failed to start task:`, err);
      this.sendEvent(msg.task_id, 'ERROR', { error: (err as Error).message });
    }
  }

  private async handleTaskResume(msg: TaskResumeMessage): Promise<void> {
    console.log(`Resuming task ${msg.task_id} with session ${msg.session_id}`);
    try {
      await this.adapter.resumeTask(msg.task_id, msg.session_id, msg.message, msg.project_path);
    } catch (err) {
      console.error(`Failed to resume task:`, err);
      this.sendEvent(msg.task_id, 'ERROR', { error: (err as Error).message });
    }
  }

  private async handleTaskCancel(msg: TaskCancelMessage): Promise<void> {
    console.log(`Cancelling task ${msg.task_id}`);
    await this.adapter.cancelTask(msg.task_id);
  }

  private handleGetMessages(msg: GetMessagesMessage): void {
    console.log(`Getting messages for session ${msg.session_id}`);
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
        newest_uuid: result.newestUuid,
      });
    } catch (err) {
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

  private handleWatchSession(msg: WatchSessionMessage): void {
    console.log(`[Watch] Starting watch for session ${msg.session_id}`);
    this.sessionWatcher.watchSession(msg.session_id, msg.file_path);
  }

  private handleUnwatchSession(msg: UnwatchSessionMessage): void {
    console.log(`[Watch] Stopping watch for session ${msg.session_id}`);
    this.sessionWatcher.unwatchSession(msg.session_id);
  }

  private handleSessionEvent(event: CodexSessionEvent): void {
    this.send({
      type: 'event',
      task_id: '',
      event_type: event.type,
      session_id: event.sessionId,
      uuid: event.uuid,
      content: event.content,
      timestamp: event.timestamp,
    });
  }

  private handleSessionCompletion(event: CodexCompletionEvent): void {
    console.log(`[Watch] Sending session_activity completion for session ${event.sessionId.slice(-8)}`);
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

  private handleVersionStatus(msg: VersionStatusMessage): void {
    if (msg.status === 'update_required') {
      console.error(`Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      this.shouldReconnect = false;
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`Update available: v${msg.latest_version} (you have v${msg.your_version})`);
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
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

  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL);
  }

  private stopPingInterval(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}
