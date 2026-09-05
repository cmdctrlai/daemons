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
  ForceQuitSessionMessage,
  ForceQuitResultMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  ContextRequestMessage,
  VersionStatusMessage,
  MessageEntry,
  SessionInfo,
  SlashCommandSet,
  SessionStatus,
} from './messages';
import { selfUpdate, isAutoUpdateSupported } from './update';

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
  /** Base reconnect delay in ms, before jitter (default: 1000) */
  baseReconnectDelay?: number;
  /** Maximum reconnect delay in ms (default: 60000) */
  maxReconnectDelay?: number;
  /** Ping interval in ms (default: 30000) */
  pingInterval?: number;
  /**
   * If true, the client will install new daemon versions automatically when
   * the server sends `version_status` with `update_available` (deferred until
   * idle) or `update_required` (immediate). Requires `autoUpdate` config.
   * Default: false – callers must opt in explicitly.
   */
  autoUpdate?: boolean;
  /** Required if `autoUpdate` is true. */
  autoUpdateConfig?: AutoUpdateConfig;
  /**
   * Log connection lifecycle plus every non-ping/pong frame as
   * `[WS IN] <type>: <json>` / `[WS OUT] <type>: <json>`, truncated to 200
   * characters. The daemon log is the primary troubleshooting surface for
   * protocol problems, so daemons that people debug in the field want this on.
   * Default: false.
   */
  logFrames?: boolean;
}

export interface AutoUpdateConfig {
  /** npm package name to install, e.g. '@cmdctrl/aider' */
  packageName: string;
  /** Binary to spawn after update, e.g. 'cmdctrl-aider' */
  binName: string;
  /**
   * Called before the daemon installs and exits. Use this to release
   * resources held by the running process (pid file, file watchers,
   * spawned child processes). Optional.
   */
  onBeforeUpdate?: () => Promise<void> | void;
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
  /** Optional base64 data URL images attached by the user */
  images?: string[];

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
  /** Optional base64 data URL images attached by the user */
  images?: string[];

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

/**
 * What a daemon did about a force-quit request. Every status except `released`
 * and `not_held` means the session is still held and the user needs telling
 * why, so `detail` carries the agent-specific reason where there is one.
 */
export interface ForceQuitOutcome {
  status: ForceQuitResultMessage['status'];
  detail?: string;
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
  /**
   * Set when the context could not be built (e.g. the session no longer
   * exists). The response is still sent so the server can stop waiting on
   * the request instead of timing it out.
   */
  error?: string;
}

// ============================================================
// Handler types
// ============================================================

type TaskStartHandler = (task: TaskHandle) => Promise<void> | void;
type TaskResumeHandler = (task: ResumeHandle) => Promise<void> | void;
type TaskCancelHandler = (taskId: string) => void;
type GetMessagesHandler = (req: GetMessagesRequest) => GetMessagesResponse | Promise<GetMessagesResponse>;
type ForceQuitSessionHandler = (
  sessionId: string
) => ForceQuitOutcome | Promise<ForceQuitOutcome>;
type WatchSessionHandler = (sessionId: string, filePath: string) => void;
type UnwatchSessionHandler = (sessionId: string) => void;
type ContextRequestHandler = (req: ContextRequest) => ContextResponse | null | Promise<ContextResponse | null>;
type VersionStatusHandler = (status: VersionStatusMessage) => void;
type AuthFailureHandler = () => void;
type SessionsProvider = () => SessionInfo[] | Promise<SessionInfo[]>;
type SlashCommandsProvider = () => SlashCommandSet[];
type RunningTasksProvider = () => string[];

/** Reads a Node response stream (e.g. the `res` from a ws 'unexpected-response' event) to completion. */
function readResponseBody(res: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => resolve(body));
    res.on('error', () => resolve(body));
  });
}

/**
 * Parses a `Retry-After` header into milliseconds. Only the integer-seconds
 * form (e.g. "12") is honoured – the HTTP-date form is technically valid
 * per RFC 7231, but the server only ever sends integer seconds, so treating
 * anything else (missing, malformed, negative, or a date) as "no minimum"
 * is a deliberate choice: it lets the caller fall back to normal backoff
 * instead of risking NaN, a negative delay, or a hot retry loop.
 */
function parseRetryAfterMs(header: string | undefined): number | undefined {
  if (!header || !/^\d+$/.test(header.trim())) return undefined;
  return Number(header.trim()) * 1000;
}

/** Frame text for the `logFrames` log lines, capped so one frame stays one line. */
function truncateFrame(json: string): string {
  return json.length > 200 ? `${json.substring(0, 200)}...` : json;
}

// ============================================================
// Client
// ============================================================

type ResolvedOptions = Omit<Required<DaemonClientOptions>, 'autoUpdateConfig'> & {
  autoUpdateConfig?: AutoUpdateConfig;
};

export class DaemonClient {
  private ws: WebSocket | null = null;
  private options: ResolvedOptions;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private sessionRefreshTimer: NodeJS.Timeout | null = null;
  private shouldReconnect = true;
  private consecutiveAuthFailures = 0;
  // Purely advisory: past this many consecutive 401s in a row, nudge the
  // caller via onAuthFailure in case the device was actually removed. We
  // never stop retrying on our own – a 401 here can't be reliably told apart
  // from a transient failure, so giving up would strand a daemon that would
  // have recovered on its own.
  private readonly authFailureWarnThreshold = 5;
  private runningTasks: Set<string> = new Set();
  private pendingAutoUpdate: VersionStatusMessage | null = null;
  private autoUpdateInProgress = false;
  private idleCheckTimer: NodeJS.Timeout | null = null;
  /**
   * Remembers the `latest_version` the server told us about most recently
   * that we already tried to install and found to be a no-op (i.e. npm's
   * registry latest matches what we already have). Stops us from
   * reattempting the same install on every reconnect. Cleared when the
   * server advertises a different latest.
   */
  private noopAutoUpdateTarget: string | null = null;

  // User-provided handlers
  private taskStartHandler?: TaskStartHandler;
  private taskResumeHandler?: TaskResumeHandler;
  private taskCancelHandler?: TaskCancelHandler;
  private getMessagesHandler?: GetMessagesHandler;
  private forceQuitSessionHandler?: ForceQuitSessionHandler;
  private watchSessionHandler?: WatchSessionHandler;
  private unwatchSessionHandler?: UnwatchSessionHandler;
  private contextRequestHandler?: ContextRequestHandler;
  private versionStatusHandler?: VersionStatusHandler;
  private authFailureHandler?: AuthFailureHandler;
  private sessionsProvider?: SessionsProvider;
  private slashCommandsProvider?: SlashCommandsProvider;
  private runningTasksProvider?: RunningTasksProvider;

  constructor(options: DaemonClientOptions) {
    this.options = {
      baseReconnectDelay: 1000,
      maxReconnectDelay: 60000,
      pingInterval: 30000,
      autoUpdate: false,
      logFrames: false,
      ...options,
    };
    if (this.options.autoUpdate && !this.options.autoUpdateConfig) {
      throw new Error('autoUpdate=true requires autoUpdateConfig');
    }
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

  /**
   * Register handler for force-quit requests. Optional: only agents whose
   * sessions can be exclusively held by a local process need one. Without a
   * handler the server is told the agent does not support it, rather than
   * being left to time out.
   */
  onForceQuitSession(handler: ForceQuitSessionHandler): this {
    this.forceQuitSessionHandler = handler;
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
   * Register handler for repeated authentication failures (HTTP 401 on
   * connect, several in a row). This is advisory only – the client keeps
   * retrying with backoff regardless of auth failures, since a 401 can't be
   * reliably distinguished from a transient server-side issue. Use this to
   * surface a "you may need to re-register this device" hint to the user.
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

  /**
   * Register a provider for the slash commands the agent accepts, per project.
   * Optional – a daemon that can't enumerate its agent's commands simply omits
   * it and clients render a composer with no autocomplete menu.
   */
  setSlashCommandsProvider(provider: SlashCommandsProvider): this {
    this.slashCommandsProvider = provider;
    return this;
  }

  /**
   * Register a provider for the running-task set. Optional.
   *
   * By default the client tracks running tasks itself, from the lifetime of
   * the `onTaskStart` / `onTaskResume` handler promises. That model does not
   * fit a daemon whose tasks end on paths no handler promise can observe – a
   * turn handed off to another process, a killed child, a task superseded by a
   * newer message for the same session. Such a daemon provides its own set
   * here, and the client reports it in `status` and consults it before
   * installing a deferred update.
   */
  setRunningTasksProvider(provider: RunningTasksProvider): this {
    this.runningTasksProvider = provider;
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

      // Warn when sending credentials over plaintext to a non-localhost host
      if (serverUrl.protocol === 'http:' && serverUrl.hostname !== 'localhost' && serverUrl.hostname !== '127.0.0.1') {
        console.warn(`⚠ Connecting over plaintext HTTP to ${serverUrl.hostname} – credentials will not be encrypted.`);
        console.warn('  Use an https:// server URL in production.');
      }

      // Declare auto-update capability so the server can render
      // honest banner copy ("will update when idle" vs. "needs an update").
      const capabilities: string[] = [];
      if (this.options.autoUpdate) capabilities.push('auto-update');

      if (this.options.logFrames) console.log(`Connecting to ${wsUrl}...`);

      this.ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${this.options.token}`,
          'X-Device-ID': this.options.deviceId,
          'X-Agent-Type': this.options.agentType,
          'X-Daemon-Version': this.options.version,
          ...(capabilities.length > 0 && { 'X-Daemon-Capabilities': capabilities.join(',') }),
        }
      });

      this.ws.on('open', async () => {
        if (this.options.logFrames) console.log('WebSocket connected');
        this.reconnectAttempt = 0;
        this.consecutiveAuthFailures = 0;
        this.startPingInterval();
        this.startSessionRefreshInterval();
        this.sendStatus();
        await this.reportSessions();
        this.reportSlashCommands();
        resolve();
      });

      this.ws.on('message', (data) => this.handleMessage(data.toString()));

      this.ws.on('close', (code, reason) => {
        if (this.options.logFrames) console.log(`WebSocket closed: ${code} ${reason}`);
        this.stopPingInterval();
        this.stopSessionRefreshInterval();
        reject(new Error('Connection closed'));
        this.scheduleReconnect();
      });

      // ws does not abort the handshake or emit 'close' on its own once a
      // listener is registered here, so a failed upgrade (401, 5xx, etc.)
      // would otherwise leave a dangling request and never retry.
      // Clean up the request and drive the retry ourselves.
      this.ws.on('unexpected-response', (req, res) => {
        req.destroy();
        this.ws = null;
        if (res.statusCode === 401) {
          this.consecutiveAuthFailures++;
          if (this.consecutiveAuthFailures === this.authFailureWarnThreshold) {
            console.error(`Authentication has failed ${this.consecutiveAuthFailures} times in a row. If this device was removed from the server, re-register with the "register" command. Retrying in the background in case this is transient.`);
            this.authFailureHandler?.();
          } else {
            console.warn(`Authentication failed (401), retrying with backoff... (attempt ${this.consecutiveAuthFailures})`);
          }
          reject(new Error('Authentication failed (401)'));
          this.scheduleReconnect();
        } else if (res.statusCode === 426) {
          // The server rejected this daemon's version before ever upgrading
          // the connection (see daemon_hub.go's pre-upgrade version gate).
          // The body is shaped like a version_status message, so route it
          // through the same handling a post-connect version_status gets -
          // this is what prints the upgrade prompt / triggers auto-update
          // and decides whether to keep retrying.
          reject(new Error('Daemon version is below the minimum supported version'));
          readResponseBody(res).then((body) => {
            try {
              const m = JSON.parse(body) as VersionStatusMessage;
              this.versionStatusHandler?.(m);
              this.handleVersionStatus(m);
            } catch {
              console.error(`Server rejected this daemon's version (426) but the response could not be read: ${body}`);
            }
            this.scheduleReconnect();
          });
        } else if (res.statusCode === 429) {
          // The server throttles connect attempts per device (see
          // daemon_hub.go's connect_throttle) and sets Retry-After to the
          // seconds remaining before the next token refills. Honour it as a
          // floor on the next attempt – normal backoff can still push the
          // delay later, but never sooner than the server asked for.
          reject(new Error('Connection rate limited (429)'));
          this.scheduleReconnect(parseRetryAfterMs(res.headers['retry-after']));
        } else {
          reject(new Error(`Unexpected server response: ${res.statusCode}`));
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        if (this.options.logFrames) console.error('WebSocket error:', err.message);
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.terminate();
        }
      });
    });
  }

  /** Disconnect from the server. */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPingInterval();
    this.stopSessionRefreshInterval();
    this.stopIdleCheck();
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

  /**
   * Report the per-project slash command sets to the server. Sent on connect and
   * whenever the daemon learns the set has changed. No-op without a provider.
   */
  reportSlashCommands(): void {
    if (!this.slashCommandsProvider) return;
    const sets = this.slashCommandsProvider();
    if (sets.length === 0) return;
    this.send({ type: 'report_slash_commands', sets });
  }

  // ------------------------------------------------------------------
  // Internal: message sending
  // ------------------------------------------------------------------

  private sendForceQuitResult(
    request: ForceQuitSessionMessage,
    outcome: ForceQuitOutcome
  ): void {
    this.send({
      type: 'force_quit_result',
      request_id: request.request_id,
      session_id: request.session_id,
      status: outcome.status,
      detail: outcome.detail,
    });
  }

  private send(message: DaemonMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      const json = JSON.stringify(message);
      if (this.options.logFrames && message.type !== 'pong') {
        console.log(`[WS OUT] ${message.type}:`, truncateFrame(json));
      }
      this.ws.send(json);
    }
  }

  sendEvent(taskId: string, eventType: string, data: Record<string, unknown> = {}): void {
    this.send({ type: 'event', task_id: taskId, event_type: eventType, ...data });
  }

  private sendStatus(): void {
    const running = this.runningTaskIds();
    this.send({ type: 'status', running_tasks: running });
    if (running.length === 0) {
      this.maybeRunPendingAutoUpdate();
    }
  }

  /** The authoritative running-task set: the caller's, if it provided one. */
  private runningTaskIds(): string[] {
    return this.runningTasksProvider ? this.runningTasksProvider() : Array.from(this.runningTasks);
  }

  // ------------------------------------------------------------------
  // Internal: auto-update
  // ------------------------------------------------------------------

  private maybeRunPendingAutoUpdate(): void {
    if (!this.pendingAutoUpdate || this.autoUpdateInProgress) return;
    if (this.runningTaskIds().length > 0) return;
    const msg = this.pendingAutoUpdate;
    this.pendingAutoUpdate = null;
    this.stopIdleCheck();
    this.runAutoUpdate(msg).catch((e) => {
      console.error('[auto-update] failed:', e);
      this.autoUpdateInProgress = false;
    });
  }

  /**
   * Poll for idleness while an update is deferred. `sendStatus` already
   * re-checks on every task transition the client itself sees, but a daemon
   * that owns its running-task set finishes tasks without telling us, so
   * without this the deferred update would wait for the next unrelated status.
   */
  private startIdleCheck(): void {
    if (this.idleCheckTimer) return;
    this.idleCheckTimer = setInterval(() => this.maybeRunPendingAutoUpdate(), 5000);
  }

  private stopIdleCheck(): void {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
  }

  private handleVersionStatus(m: VersionStatusMessage): void {
    const cfg = this.options.autoUpdateConfig;
    const auto = this.options.autoUpdate && cfg !== undefined;

    if (m.status === 'current') return;

    // Don't retry an auto-update attempt that already proved no-op for the
    // same target (e.g. the server advertised a version that isn't actually
    // published yet). Clearing happens once the server advertises a
    // different latest_version.
    if (auto && m.latest_version && this.noopAutoUpdateTarget === m.latest_version) {
      return;
    }
    if (m.latest_version && this.noopAutoUpdateTarget && this.noopAutoUpdateTarget !== m.latest_version) {
      this.noopAutoUpdateTarget = null;
    }

    if (m.status === 'update_required') {
      console.error(`\n✖ Daemon v${m.your_version} is no longer supported (minimum: v${m.min_version}).`);
      if (m.changelog_url) console.error(`  Changelog: ${m.changelog_url}`);
      if (m.message) console.error(`  ${m.message}`);
      if (auto) {
        // Server has logically disconnected us – install immediately, don't wait for idle.
        this.runAutoUpdate(m).catch((e) => {
          console.error('[auto-update] failed:', e);
          this.autoUpdateInProgress = false;
        });
      } else {
        console.error(`  Run: ${cfg ? cfg.binName : 'cmdctrl-<daemon>'} update\n`);
        this.shouldReconnect = false;
        this.disconnect();
      }
      return;
    }

    // update_available
    if (!auto) {
      console.warn(`\n⚠ Update available: v${m.latest_version} (you have v${m.your_version})`);
      if (m.changelog_url) console.warn(`  Changelog: ${m.changelog_url}`);
      console.warn(`  Run: ${cfg ? cfg.binName : 'cmdctrl-<daemon>'} update\n`);
      return;
    }

    const running = this.runningTaskIds();
    if (running.length === 0) {
      this.runAutoUpdate(m).catch((e) => {
        console.error('[auto-update] failed:', e);
        this.autoUpdateInProgress = false;
      });
    } else {
      this.pendingAutoUpdate = m;
      console.log(`\n[auto-update] update available (v${m.latest_version}). Deferring until ${running.length} active task(s) complete.`);
      this.startIdleCheck();
    }
  }

  private async runAutoUpdate(msg: VersionStatusMessage): Promise<void> {
    const cfg = this.options.autoUpdateConfig;
    if (!cfg) return;
    this.autoUpdateInProgress = true;
    this.stopIdleCheck();

    if (!isAutoUpdateSupported()) {
      console.warn(`\n⚠ Update available (v${msg.latest_version}) but auto-update is not supported on this platform.`);
      console.warn(`  Run manually: npm install -g ${cfg.packageName}@latest`);
      this.autoUpdateInProgress = false;
      return;
    }

    console.log(`\n[auto-update] installing ${cfg.packageName}@${msg.latest_version} (current: ${this.options.version})`);

    if (cfg.onBeforeUpdate) {
      try {
        await cfg.onBeforeUpdate();
      } catch (e) {
        console.error('[auto-update] onBeforeUpdate failed:', e);
      }
    }

    this.shouldReconnect = false;
    await this.disconnect();

    const result = await selfUpdate({
      packageName: cfg.packageName,
      binName: cfg.binName,
      currentVersion: this.options.version,
      latestVersion: msg.latest_version,
      restartAfter: true,
    });

    if (result.status === 'updated') {
      console.log(`[auto-update] installed v${result.toVersion}; daemon restarting under new version.`);
      process.exit(0);
    } else if (result.status === 'up-to-date') {
      // Server's policy said a newer version exists, but npm install pulled
      // the same version we're already on – likely because the policy's
      // latest_version isn't actually published yet. Don't loop: remember
      // this target so the next version_status with the same latest_version
      // is ignored until the server advertises a different version.
      console.warn(`[auto-update] no-op: npm latest is still v${result.toVersion}; server's latest (v${msg.latest_version}) may not be published yet.`);
      this.noopAutoUpdateTarget = msg.latest_version ?? null;
      this.autoUpdateInProgress = false;
      if (msg.status === 'update_required') {
        // Server has already rejected us; reconnecting would just get another
        // immediate disconnect. Print a manual-install hint and stay down.
        console.error(`  Required version is not on npm yet. Once it's published, run: ${cfg.binName} update`);
        this.shouldReconnect = false;
      } else {
        this.shouldReconnect = true;
        this.connect().catch(() => {});
      }
    } else {
      console.error(`[auto-update] ${result.status}: ${result.error ?? 'unknown error'}`);
      this.autoUpdateInProgress = false;
      // For update_required the server has rejected us; staying connected is futile.
      if (msg.status !== 'update_required') {
        this.shouldReconnect = true;
        this.connect().catch(() => {});
      }
    }
  }

  // ------------------------------------------------------------------
  // Internal: task handle factory
  // ------------------------------------------------------------------

  private createTaskHandle(taskId: string, msg: TaskStartMessage): TaskHandle {
    return {
      taskId,
      instruction: msg.instruction,
      projectPath: msg.project_path,
      images: msg.images,
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
      images: msg.images,
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
      if (this.options.logFrames) console.error('Failed to parse message:', raw);
      return;
    }

    if (this.options.logFrames && msg.type !== 'ping') {
      console.log(`[WS IN] ${msg.type}:`, truncateFrame(raw));
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

      case 'force_quit_session': {
        const m = msg as ForceQuitSessionMessage;
        if (!this.forceQuitSessionHandler) {
          this.sendForceQuitResult(m, {
            status: 'failed',
            detail: 'This agent does not support force quit.',
          });
          break;
        }
        try {
          this.sendForceQuitResult(m, await this.forceQuitSessionHandler(m.session_id));
        } catch (err: unknown) {
          this.sendForceQuitResult(m, {
            status: 'failed',
            detail: err instanceof Error ? err.message : 'Unknown error',
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
              error: ctx.error,
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
        this.handleVersionStatus(m);
        break;
      }

      default:
        // A newer server asking for something this SDK predates. Silence would
        // leave the server waiting out its own timeout on a request nobody will
        // ever answer.
        if (this.options.logFrames) {
          console.log(`[WS IN] ignoring unknown message type: ${(msg as { type: string }).type}`);
        }
        break;
    }
  }

  // ------------------------------------------------------------------
  // Internal: reconnection and keepalive
  // ------------------------------------------------------------------

  /**
   * Unbounded reconnect: capped exponential backoff with full jitter
   * (uniform between 0 and min(cap, base * 2^attempt)). Never gives up –
   * a transient outage must recover without the daemon exiting or a human
   * re-registering it. `connect()`'s own failure handlers call this, so a
   * connection attempt reschedules itself on failure. `minDelayMs` sets a
   * floor under the computed backoff (e.g. from a 429's Retry-After) – it
   * can only push the delay later, never shorten it.
   */
  private scheduleReconnect(minDelayMs = 0): void {
    if (!this.shouldReconnect || this.reconnectTimer) return;
    const delay = Math.max(this.nextReconnectDelay(this.reconnectAttempt), minDelayMs);
    this.reconnectAttempt++;
    if (this.options.logFrames) console.log(`Reconnecting in ${Math.round(delay / 1000)}s...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  private nextReconnectDelay(attempt: number): number {
    const { baseReconnectDelay, maxReconnectDelay } = this.options;
    const exp = Math.min(maxReconnectDelay, baseReconnectDelay * 2 ** Math.min(attempt, 20));
    return Math.random() * exp;
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
