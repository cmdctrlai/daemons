import WebSocket from 'ws';
import { URL } from 'url';
import { CmdCtrlConfig, Credentials } from '../config/config';
import { getCDPClient } from '../adapter/cdp-client';
import { getCursorDB } from '../adapter/cursor-db';
import {
  ServerMessage,
  DaemonMessage,
  TaskStartMessage,
  TaskResumeMessage,
  GetMessagesMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  VersionStatusMessage,
  SessionInfo,
} from './messages';
import { readFileSync } from 'fs';
import { join } from 'path';
import { discoverSessions, ExternalSession } from '../session-discovery';
import { getSessionWatcher, SessionActivityEvent } from '../session-watcher';

const MAX_RECONNECT_DELAY = 30000; // 30 seconds
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const PING_INTERVAL = 30000; // 30 seconds
const SESSION_REFRESH_INTERVAL = 300000; // 5 minutes

export class DaemonClient {
  private ws: WebSocket | null = null;
  private config: CmdCtrlConfig;
  private credentials: Credentials;
  private reconnectDelay = INITIAL_RECONNECT_DELAY;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private sessionRefreshTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private managedSessionIds: Set<string> = new Set();
  private runningTasks: Set<string> = new Set();

  constructor(config: CmdCtrlConfig, credentials: Credentials) {
    this.config = config;
    this.credentials = credentials;
  }

  /**
   * Handle session activity from the watcher and forward to server
   */
  private handleSessionActivity(event: SessionActivityEvent): void {
    console.log(`[SessionWatcher] Sending activity for session ${event.session_id}`);
    this.send({
      type: 'session_activity',
      session_id: event.session_id,
      file_path: event.file_path,
      last_message: event.last_message,
      message_count: event.message_count,
      is_completion: event.is_completion,
      user_message_uuid: event.user_message_uuid,
    });
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
          'X-Daemon-Version': daemonVersion,
        },
      });

      let wasOpen = false;

      this.ws.on('open', () => {
        wasOpen = true;
        console.log('WebSocket connected');
        this.reconnectDelay = INITIAL_RECONNECT_DELAY;
        this.startPingInterval();
        this.startSessionRefreshInterval();
        this.startSessionWatcher();
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
        this.stopSessionWatcher();
        if (wasOpen) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('unexpected-response', (_req, res) => {
        if (res.statusCode === 401) {
          console.error('Authentication failed (401). Device may have been removed from the server.');
          console.error('Run "cmdctrl-cursor-ide register" again to re-register this device.');
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
    this.stopSessionRefreshInterval();
    this.stopSessionWatcher();

    // Disconnect CDP client
    getCDPClient().disconnect();

    // Close cursor DB
    getCursorDB().close();

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
    this.send({
      type: 'event',
      task_id: taskId,
      event_type: eventType,
      ...data,
    });
  }

  /**
   * Send current status to server
   */
  private sendStatus(): void {
    this.send({
      type: 'status',
      running_tasks: Array.from(this.runningTasks),
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
        // For Cursor, we can't really cancel a running AI response
        console.log(`Task cancel requested for ${msg.task_id} (not implemented for Cursor)`);
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
   * Handle task_start message - send message to Cursor via CDP
   */
  private async handleTaskStart(msg: TaskStartMessage): Promise<void> {
    console.log(`Starting task ${msg.task_id}: ${msg.instruction.substring(0, 50)}...`);

    const cdp = getCDPClient();

    // Check if CDP is available
    const available = await cdp.isAvailable();
    if (!available) {
      console.error('CDP not available - Cursor not running with debug port?');
      this.sendEvent(msg.task_id, 'ERROR', {
        error: 'Cursor not available. Please start Cursor with: /Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222',
      });
      return;
    }

    try {
      // Connect to CDP
      await cdp.connect();

      // Check if composer is open
      const composerOpen = await cdp.isComposerOpen();
      if (!composerOpen) {
        console.log('Opening composer panel...');
        await cdp.toggleComposer();
        // Wait a bit for panel to open
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Snapshot bubble counts before sending so we can detect which composer received the message
      const cursorDb = getCursorDB();
      const beforeBubbleCounts = new Map<string, number>();
      for (const c of cursorDb.getComposers()) {
        beforeBubbleCounts.set(c.composerId, cursorDb.getBubbleCount(c.composerId));
      }

      // Send the message
      const success = await cdp.sendMessage(msg.instruction);

      if (success) {
        this.runningTasks.add(msg.task_id);

        // Poll to discover which session received the message (new bubble appears quickly after send)
        let discoveredSessionId = '';
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          const afterComposers = cursorDb.getComposers();
          for (const c of afterComposers) {
            const prevCount = beforeBubbleCounts.get(c.composerId);
            const currentCount = cursorDb.getBubbleCount(c.composerId);
            if (prevCount === undefined || currentCount > prevCount) {
              discoveredSessionId = c.composerId;
              break;
            }
          }
          if (discoveredSessionId) break;
        }

        if (discoveredSessionId) {
          console.log(`[TaskStart] Discovered session ID: ${discoveredSessionId}`);
          this.sendEvent(msg.task_id, 'SESSION_STARTED', {
            session_id: discoveredSessionId,
          });
        } else {
          console.warn('[TaskStart] Could not discover session ID after 10s');
        }

        this.sendEvent(msg.task_id, 'TASK_COMPLETE', {
          result: 'Message sent to Cursor',
          session_id: discoveredSessionId,
        });
        this.runningTasks.delete(msg.task_id);
      } else {
        this.sendEvent(msg.task_id, 'ERROR', {
          error: 'Failed to send message to Cursor',
        });
      }
    } catch (err) {
      console.error(`Failed to start task ${msg.task_id}:`, err);
      this.sendEvent(msg.task_id, 'ERROR', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Handle task_resume message - send follow-up message to Cursor
   */
  private async handleTaskResume(msg: TaskResumeMessage): Promise<void> {
    console.log(`Resuming task ${msg.task_id} with message`);

    const cdp = getCDPClient();

    try {
      await cdp.connect();
      const success = await cdp.sendMessage(msg.message);

      if (success) {
        this.sendEvent(msg.task_id, 'TASK_COMPLETE', {
          result: 'Follow-up message sent to Cursor',
          session_id: msg.session_id,
        });
      } else {
        this.sendEvent(msg.task_id, 'ERROR', {
          error: 'Failed to send follow-up message to Cursor',
        });
      }
    } catch (err) {
      console.error(`Failed to resume task ${msg.task_id}:`, err);
      this.sendEvent(msg.task_id, 'ERROR', {
        error: (err as Error).message,
      });
    }
  }

  /**
   * Handle get_messages request - read from Cursor SQLite database
   */
  private handleGetMessages(msg: GetMessagesMessage): void {
    console.log(`Getting messages for session ${msg.session_id}, limit=${msg.limit}, after=${msg.after_uuid || 'none'}`);

    try {
      const cursorDb = getCursorDB();
      const result = cursorDb.getMessages(msg.session_id, msg.limit, msg.before_uuid, msg.after_uuid);

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
   * Handle watch_session request
   */
  private handleWatchSession(msg: WatchSessionMessage): void {
    console.log(`Starting to watch session ${msg.session_id}`);
    const watcher = getSessionWatcher();
    watcher.watchSession(msg.session_id);
  }

  /**
   * Handle unwatch_session request
   */
  private handleUnwatchSession(msg: UnwatchSessionMessage): void {
    console.log(`Stopping watch for session ${msg.session_id}`);
    const watcher = getSessionWatcher();
    watcher.unwatchSession(msg.session_id);
  }

  /**
   * Handle version_status message from server
   */
  private handleVersionStatus(msg: VersionStatusMessage): void {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error(`  Run: cmdctrl-cursor-ide update`);
      if (msg.changelog_url) console.error(`  Changelog: ${msg.changelog_url}`);
      if (msg.message) console.error(`  ${msg.message}`);
      console.error('');
      this.shouldReconnect = false;
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn(`  Run: cmdctrl-cursor-ide update`);
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

  /**
   * Start the session watcher
   */
  private startSessionWatcher(): void {
    const watcher = getSessionWatcher();
    watcher.start(this.handleSessionActivity.bind(this));
  }

  /**
   * Stop the session watcher
   */
  private stopSessionWatcher(): void {
    const watcher = getSessionWatcher();
    watcher.stop();
  }

  /**
   * Report discovered external sessions to server
   */
  private reportSessions(): void {
    try {
      const sessions = discoverSessions(this.managedSessionIds);

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
        message_count: s.message_count,
      }));

      this.send({
        type: 'report_sessions',
        sessions: sessionInfos,
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
   * Add a session ID to the managed set
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
}
