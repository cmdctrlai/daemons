import WebSocket from 'ws';
import { URL } from 'url';
import { CmdCtrlConfig, Credentials, writeCredentials } from '../config/config';
import { AiderAdapter } from '../adapter/agentapi';
import {
  ServerMessage,
  DaemonMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
  VersionStatusMessage,
} from './messages';
import { readFileSync } from 'fs';
import { join } from 'path';

const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const PING_INTERVAL = 30000; // 30 seconds

export class DaemonClient {
  private ws: WebSocket | null = null;
  private config: CmdCtrlConfig;
  private credentials: Credentials;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private adapter: AiderAdapter;

  constructor(config: CmdCtrlConfig, credentials: Credentials) {
    this.config = config;
    this.credentials = credentials;
    this.adapter = new AiderAdapter(this.sendEvent.bind(this));
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
          'X-Agent-Type': 'aider',
          'X-Daemon-Version': daemonVersion,
        }
      });

      this.ws.on('open', () => {
        wasOpen = true;
        console.log('WebSocket connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.startPingInterval();
        this.sendStatus();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      let wasOpen = false;

      this.ws.on('close', (code, reason) => {
        console.log(`WebSocket closed: ${code} ${reason}`);
        this.stopPingInterval();
        // Only reconnect from close if connection was established.
        // Handshake failures (401, network error) are handled by the
        // catch block in scheduleReconnect with proper exponential backoff.
        if (wasOpen) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          console.error('Authentication failed (401). Device may have been removed from the server.');
          console.error('Run "cmdctrl-aider register" again to re-register this device.');
          this.shouldReconnect = false;
          process.exit(1);
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

    // Stop all running tasks
    await this.adapter.stopAll();

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
  private sendEvent(
    taskId: string,
    eventType: string,
    data: Record<string, unknown>
  ): void {
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
  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as ServerMessage;

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
        case 'unwatch_session':
          // Aider doesn't support file watching (Claude Code specific)
          // Silently ignore these messages
          break;

        case 'version_status':
          this.handleVersionStatus(msg as VersionStatusMessage);
          break;

        default:
          console.log(`Unknown message type: ${(msg as { type: string }).type}`);
      }
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  }

  /**
   * Handle task_start message
   */
  private async handleTaskStart(msg: TaskStartMessage): Promise<void> {
    console.log(`Received task_start: ${msg.task_id}`);
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
    console.log(`Received task_resume: ${msg.task_id}`);
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
    console.log(`Received task_cancel: ${msg.task_id}`);
    await this.adapter.cancelTask(msg.task_id);
  }

  /**
   * Handle get_messages request
   * Fetches messages from AgentAPI's /messages endpoint
   */
  private async handleGetMessages(msg: GetMessagesMessage): Promise<void> {
    console.log(`Received get_messages for session: ${msg.session_id}, after=${msg.after_uuid || 'none'}`);

    // The session_id is the canonical ID like "dev-xxx:aider:PENDING-xxx"
    // We need to find the task_id which matches this session
    const taskId = msg.session_id;

    const messages = await this.adapter.getMessages(taskId);

    if (messages === null) {
      // AgentAPI not running for this session
      this.send({
        type: 'messages',
        request_id: msg.request_id,
        session_id: msg.session_id,
        messages: [],
        has_more: false,
        error: 'Session not active - AgentAPI not running'
      });
      return;
    }

    // Convert AgentAPI messages to our format
    let formattedMessages = messages.map(m => ({
      uuid: `aider-msg-${m.id}`,
      role: m.role === 'agent' ? 'AGENT' as const : 'USER' as const,
      content: m.content,
      timestamp: m.time
    }));

    // Handle after_uuid for incremental fetches
    if (msg.after_uuid) {
      const afterIdx = formattedMessages.findIndex(m => m.uuid === msg.after_uuid);
      if (afterIdx !== -1) {
        formattedMessages = formattedMessages.slice(afterIdx + 1);
      }
    }

    this.send({
      type: 'messages',
      request_id: msg.request_id,
      session_id: msg.session_id,
      messages: formattedMessages,
      has_more: false,
      newest_uuid: formattedMessages.length > 0 ? formattedMessages[formattedMessages.length - 1].uuid : undefined,
    });
  }

  /**
   * Handle version_status message from server
   */
  private handleVersionStatus(msg: VersionStatusMessage): void {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error(`  Run: cmdctrl-aider update`);
      if (msg.changelog_url) console.error(`  Changelog: ${msg.changelog_url}`);
      if (msg.message) console.error(`  ${msg.message}`);
      console.error('');
      this.shouldReconnect = false;
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn(`  Run: cmdctrl-aider update`);
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

    console.log(`Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
      } catch (err) {
        console.error('Reconnection failed:', err);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, MAX_RECONNECT_DELAY);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  /**
   * Start ping interval to keep connection alive
   */
  private startPingInterval(): void {
    this.pingTimer = setInterval(() => {
      this.sendStatus();
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
