/**
 * Wires the Claude Code daemon's machinery onto the CmdCtrl daemon SDK.
 *
 * The SDK owns the transport – connection, reconnect, keepalive, protocol
 * routing, version gating and self-update. Everything here is Claude
 * Code-specific: spawning the CLI, watching session JSONL files, discovering
 * sessions started outside CmdCtrl, and reading message history back.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, isAutoUpdateSupported } from '@cmdctrl/daemon-sdk';
import { CmdCtrlConfig, Credentials, deletePidFile } from '../config/config';
import { ClaudeAdapter } from '../adapter/claude-cli';
import { SessionWatcher, SessionEvent, CompletionEvent } from '../session-watcher';
import { discoverSessions } from '../session-discovery';
import { readMessages, findSessionFile } from '../message-reader';
import { extractSessionContext } from '../handlers/context-handler';

const PACKAGE_NAME = '@cmdctrl/claude-code';
const BIN_NAME = 'cmdctrl-claude-code';

/**
 * Delays before re-looking for a session's JSONL file after SESSION_STARTED.
 * Claude Code creates the file a moment after it reports the session id, and
 * the watcher is what streams verbose output during the first turn.
 */
const WATCH_RETRY_DELAYS = [500, 1000, 2000, 4000];

export interface ClaudeCodeDaemon {
  client: DaemonClient;
  /** Stop running tasks and file watchers, then close the connection. */
  shutdown(): Promise<void>;
}

/** Read this daemon's version, tolerating both the built and source layouts. */
function readDaemonVersion(): string {
  for (const rel of [['..', 'package.json'], ['..', '..', 'package.json']]) {
    try {
      return JSON.parse(readFileSync(join(__dirname, ...rel), 'utf-8')).version;
    } catch {
      continue;
    }
  }
  return 'unknown';
}

export function createDaemon(config: CmdCtrlConfig, credentials: Credentials): ClaudeCodeDaemon {
  const version = readDaemonVersion();

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'claude_code',
    token: credentials.refreshToken,
    version,
    logFrames: true,
    // Windows can't replace the running launcher shim, so don't advertise a
    // capability we can't honour – the server renders an upgrade prompt instead.
    autoUpdate: isAutoUpdateSupported(),
    autoUpdateConfig: {
      packageName: PACKAGE_NAME,
      binName: BIN_NAME,
      onBeforeUpdate: async () => {
        await adapter.stopAll();
        sessionWatcher.unwatchAll();
        deletePidFile();
      },
    },
  });

  const sessionWatcher = new SessionWatcher(
    (event: SessionEvent) => {
      client.sendEvent('', event.type, {
        session_id: event.sessionId,
        uuid: event.uuid,
        content: event.content,
        timestamp: event.timestamp,
      });
    },
    (event: CompletionEvent) => {
      console.log(`[WS] Sending session_activity completion for session ${event.sessionId.slice(-8)}`);
      client.sendSessionActivity(
        event.sessionId,
        event.filePath,
        event.lastMessage,
        event.messageCount,
        true,
      );
    },
  );

  const adapter = new ClaudeAdapter((taskId, eventType, data) => {
    watchSessionFromEvent(eventType, data.session_id as string | undefined);
    client.sendEvent(taskId, eventType, data);
    if (eventType === 'TASK_COMPLETE') {
      fireBackupCompletion(data.session_id as string | undefined, data.result as string | undefined);
    }
  });

  /**
   * Watch a task's session file as soon as we learn its id, so agent output
   * reaches the app through the same path as a session started from the CLI.
   */
  function watchSessionFromEvent(eventType: string, sessionId?: string): void {
    if (!sessionId) return;

    const filePath = findSessionFile(sessionId);
    if (filePath) {
      console.log(`[WS] Auto-watching session ${sessionId} for unified notifications`);
      sessionWatcher.watchSession(sessionId, filePath);
      return;
    }

    if (eventType !== 'SESSION_STARTED') return;

    let attempt = 0;
    const retry = () => {
      if (attempt >= WATCH_RETRY_DELAYS.length) return;
      const delay = WATCH_RETRY_DELAYS[attempt];
      setTimeout(() => {
        const path = findSessionFile(sessionId);
        if (path) {
          console.log(`[WS] Auto-watching session ${sessionId} after ${delay}ms retry`);
          sessionWatcher.watchSession(sessionId, path);
        } else {
          attempt++;
          retry();
        }
      }, delay);
    };
    retry();
  }

  /**
   * The watcher's own completion signal is the primary one. This covers turns
   * whose JSONL never produces a completion marker; `reserveCompletionFire`
   * keeps the two paths from notifying the user twice for one turn.
   */
  function fireBackupCompletion(sessionId?: string, result?: string): void {
    if (!sessionId) return;
    const filePath = findSessionFile(sessionId);
    if (!filePath || !sessionWatcher.reserveCompletionFire(sessionId)) return;

    console.log(`[WS] TASK_COMPLETE backup: sending session_activity for session ${sessionId.slice(-8)}`);
    client.sendSessionActivity(sessionId, filePath, (result || '').slice(0, 200), 0, true);
  }

  client.setRunningTasksProvider(() => adapter.getRunningTasks());

  client.setSessionsProvider(() => discoverSessions());

  client.onTaskStart(async (task) => {
    console.log(`Starting task ${task.taskId}: ${task.instruction.substring(0, 50)}...`);
    try {
      await adapter.startTask(task.taskId, task.instruction, task.projectPath, task.images);
    } catch (err) {
      console.error(`Failed to start task ${task.taskId}:`, err);
      task.error((err as Error).message);
    }
  });

  client.onTaskResume(async (task) => {
    console.log(`Resuming task ${task.taskId} with session ${task.sessionId}`);
    try {
      await adapter.resumeTask(task.taskId, task.sessionId, task.message, task.projectPath, task.images);
    } catch (err) {
      console.error(`Failed to resume task ${task.taskId}:`, err);
      task.error((err as Error).message);
    }
  });

  client.onTaskCancel((taskId) => {
    console.log(`Cancelling task ${taskId}`);
    void adapter.cancelTask(taskId);
  });

  client.onGetMessages((req) => {
    console.log(`Getting messages for session ${req.sessionId}, limit=${req.limit}, before=${req.beforeUuid || 'none'}, after=${req.afterUuid || 'none'}`);
    const result = readMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
    console.log(`Returning ${result.messages.length} messages, has_more=${result.hasMore}`);
    return result;
  });

  client.onWatchSession((sessionId, filePath) => {
    console.log(`Starting to watch session ${sessionId} at ${filePath}`);
    sessionWatcher.watchSession(sessionId, filePath);
  });

  client.onUnwatchSession((sessionId) => {
    console.log(`Stopping watch for session ${sessionId}`);
    sessionWatcher.unwatchSession(sessionId);
  });

  client.onContextRequest((req) => {
    console.log(`Context request for session ${req.sessionId}`);
    const context = extractSessionContext(req.sessionId, {
      includeInitialPrompt: req.includeInitialPrompt,
      recentMessagesCount: req.recentMessagesCount,
      includeLastToolUse: req.includeLastToolUse,
    });

    if (!context) {
      console.log(`Context request failed: Session ${req.sessionId} not found`);
      return {
        title: '',
        projectPath: '',
        messageCount: 0,
        lastActivityAt: new Date().toISOString(),
        status: 'stale',
        error: `Session ${req.sessionId} not found`,
      };
    }

    console.log(`Sent context for session ${req.sessionId}: status=${context.status}, messages=${context.messageCount}`);
    return context;
  });

  return {
    client,
    shutdown: async () => {
      await adapter.stopAll();
      sessionWatcher.unwatchAll();
      await client.disconnect();
    },
  };
}
