/**
 * CmdCtrl Daemon Client
 *
 * Manages the WebSocket connection to the CmdCtrl server, handles the
 * protocol lifecycle, and dispatches incoming messages to the agent.
 *
 * This is the core of the daemon. Most of the code here is protocol
 * boilerplate that you won't need to modify. Your agent logic lives
 * in agent.ts instead.
 */

import WebSocket from 'ws';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import {
  ServerMessage,
  DaemonMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
} from './messages';
import { startTask, resumeTask, cancelTask, registerSession } from './agent';
import { storeMessage, getMessages } from './message-store';
import { Config, Credentials } from './config';

// Change this to your agent type (snake_case, shown in the UI)
const AGENT_TYPE = 'example';
const DAEMON_VERSION = '1.0.0';

const MAX_RECONNECT_DELAY = 30000;
const INITIAL_RECONNECT_DELAY = 1000;
const PING_INTERVAL = 30000;

export class DaemonClient {
  private ws: WebSocket | null = null;
  private config: Config;
  private credentials: Credentials;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private runningTasks: string[] = [];

  constructor(config: Config, credentials: Credentials) {
    this.config = config;
    this.credentials = credentials;
  }

  // ------------------------------------------------------------------
  // Connection management
  // ------------------------------------------------------------------

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const serverUrl = new URL(this.config.serverUrl);
      const wsProtocol = serverUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${serverUrl.host}/ws/daemon`;

      console.log(`Connecting to ${wsUrl}...`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.credentials.refreshToken}`,
          'X-Device-ID': this.config.deviceId,
          'X-Agent-Type': AGENT_TYPE,
          'X-Daemon-Version': DAEMON_VERSION,
        }
      });

      this.ws.on('open', () => {
        console.log('Connected to CmdCtrl server');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.startPingInterval();

        // Required: send status and report_sessions on connect
        this.sendStatus();
        this.send({ type: 'report_sessions', sessions: [] });

        resolve();
      });

      this.ws.on('message', (data) => this.handleMessage(data.toString()));

      this.ws.on('close', (code, reason) => {
        console.log(`Disconnected: ${code} ${reason}`);
        this.stopPingInterval();
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        console.error('WebSocket error:', err.message);
        if (this.ws?.readyState === WebSocket.CONNECTING) {
          reject(err);
        }
      });
    });
  }

  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    this.stopPingInterval();
    if (this.ws) {
      this.ws.close(1000, 'Daemon shutting down');
      this.ws = null;
    }
  }

  // ------------------------------------------------------------------
  // Message sending
  // ------------------------------------------------------------------

  private send(message: DaemonMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private sendEvent(taskId: string, eventType: string, data: Record<string, unknown> = {}): void {
    this.send({
      type: 'event',
      task_id: taskId,
      event_type: eventType,
      ...data,
    });
  }

  private sendStatus(): void {
    this.send({ type: 'status', running_tasks: this.runningTasks });
  }

  private addRunningTask(taskId: string): void {
    this.runningTasks.push(taskId);
    this.sendStatus();
  }

  private removeRunningTask(taskId: string): void {
    this.runningTasks = this.runningTasks.filter(t => t !== taskId);
    this.sendStatus();
  }

  // ------------------------------------------------------------------
  // Message handling
  // ------------------------------------------------------------------

  private handleMessage(raw: string): void {
    let msg: ServerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error('Failed to parse message:', raw);
      return;
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
      case 'version_status':
        if (msg.status === 'update_required') {
          console.error(`Version ${msg.your_version} is no longer supported. Please update.`);
          this.shouldReconnect = false;
          process.exit(1);
        }
        break;
      // watch_session and unwatch_session are optional — ignore if not needed
      default:
        break;
    }
  }

  // ------------------------------------------------------------------
  // Task handlers
  // ------------------------------------------------------------------

  private async handleTaskStart(msg: TaskStartMessage): Promise<void> {
    const taskId = msg.task_id;
    console.log(`Starting task: ${msg.instruction.substring(0, 80)}`);

    this.addRunningTask(taskId);

    // Generate a native session ID for this task
    const sessionId = randomUUID();

    // Tell the server our native session ID (resolves the PENDING placeholder)
    this.sendEvent(taskId, 'SESSION_STARTED', { session_id: sessionId });

    // Store the user's message
    storeMessage(sessionId, 'USER', msg.instruction);

    try {
      // Run the agent (this is where your integration does the real work)
      const result = await startTask(
        msg.instruction,
        msg.project_path,
        (action, target) => this.sendEvent(taskId, 'PROGRESS', { action, target })
      );

      // Store the agent's response
      storeMessage(sessionId, 'AGENT', result);

      // Register conversation history with the agent
      registerSession(sessionId, msg.instruction, result);

      // Report completion
      this.sendEvent(taskId, 'TASK_COMPLETE', { result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.sendEvent(taskId, 'ERROR', { error: message });
    }

    this.removeRunningTask(taskId);
  }

  private async handleTaskResume(msg: TaskResumeMessage): Promise<void> {
    const taskId = msg.task_id;
    console.log(`Resuming session ${msg.session_id}: ${msg.message.substring(0, 80)}`);

    this.addRunningTask(taskId);

    // Store the user's follow-up message
    storeMessage(msg.session_id, 'USER', msg.message);

    try {
      const result = await resumeTask(
        msg.session_id,
        msg.message,
        msg.project_path,
        (action, target) => this.sendEvent(taskId, 'PROGRESS', { action, target })
      );

      storeMessage(msg.session_id, 'AGENT', result);
      this.sendEvent(taskId, 'TASK_COMPLETE', { result });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.sendEvent(taskId, 'ERROR', { error: message });
    }

    this.removeRunningTask(taskId);
  }

  private handleTaskCancel(msg: TaskCancelMessage): void {
    console.log(`Cancelling task: ${msg.task_id}`);
    // Extract native session ID from canonical ID (device:agent:native)
    const parts = msg.task_id.split(':');
    if (parts.length >= 3) {
      cancelTask(parts.slice(2).join(':'));
    }
    this.removeRunningTask(msg.task_id);
  }

  private handleGetMessages(msg: GetMessagesMessage): void {
    const result = getMessages(msg.session_id, msg.limit, msg.before_uuid, msg.after_uuid);
    this.send({
      type: 'messages',
      request_id: msg.request_id,
      session_id: msg.session_id,
      messages: result.messages,
      has_more: result.hasMore,
      oldest_uuid: result.oldestUuid,
      newest_uuid: result.newestUuid,
    });
  }

  // ------------------------------------------------------------------
  // Reconnection and keepalive
  // ------------------------------------------------------------------

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
