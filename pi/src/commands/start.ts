/**
 * Start command – connect to the CmdCtrl server and run as a daemon.
 *
 * Wires the `pi` CLI (via `../agent.ts`) to the SDK's DaemonClient. Session
 * storage and message history both live in pi's native session files under
 * `~/.pi/agent/sessions/` – there is no daemon-side store. See
 * `../session-reader.ts` and `../session-watcher.ts`.
 */

import { spawnSync } from 'child_process';
import {
  DaemonClient,
  type MessageEntry,
} from '@cmdctrl/daemon-sdk';
import { AGENT_TYPE, DAEMON_VERSION, PI_BIN, config } from '../context';
import { piSdk } from '../pi-sdk';
import { startTask, resumeTask, cancelTask } from '../agent';
import { readMessages, listReportedSessions } from '../session-reader';
import {
  SessionWatcher,
  type AgentResponseEvent,
  type VerboseEvent,
  type CompletionEvent,
} from '../session-watcher';

export async function start(): Promise<void> {
  if (!config.isRegistered()) {
    console.error('Not registered. Run: cmdctrl-pi register -s <server-url>');
    process.exit(1);
  }
  if (config.isDaemonRunning()) {
    console.error('Daemon is already running.');
    process.exit(1);
  }

  const cfg = config.readConfig()!;
  const creds = config.readCredentials()!;

  console.log(`Starting daemon for device "${cfg.deviceName}"...`);
  console.log(`Server: ${cfg.serverUrl}`);

  await checkPiVersion();

  config.writePidFile(process.pid);

  // --- SDK client ---
  const client = new DaemonClient({
    serverUrl: cfg.serverUrl,
    deviceId: cfg.deviceId,
    agentType: AGENT_TYPE,
    token: creds.refreshToken,
    version: DAEMON_VERSION,
  });

  // --- Session watcher. Emits events for active observers of a session. ---
  const watcher = new SessionWatcher({
    onAgentResponse: (ev: AgentResponseEvent) => {
      // task_id is empty for watcher-emitted events: the data is file-derived,
      // not tied to a currently-running task (may arrive mid-run or long after).
      client.sendEvent('', 'AGENT_RESPONSE', {
        session_id: ev.sessionId,
        uuid: ev.uuid,
        content: ev.content,
        timestamp: ev.timestamp,
      });
    },
    onVerbose: (ev: VerboseEvent) => {
      client.sendEvent('', 'VERBOSE', {
        session_id: ev.sessionId,
        uuid: ev.uuid,
        kind: ev.kind,
        content: ev.summary,
        timestamp: ev.timestamp,
      });
    },
    onCompletion: (ev: CompletionEvent) => {
      client.sendSessionActivity(
        ev.sessionId,
        ev.filePath,
        ev.lastMessage,
        ev.messageCount,
        true,
      );
    },
  });

  // --- Handlers ---
  client.onTaskStart(async (task) => {
    console.log(`Starting task: ${task.instruction.substring(0, 80)}`);
    const { result } = await startTask(
      task.instruction,
      task.projectPath,
      (action, target) => task.progress(action, target),
      (piSessionId) => task.sessionStarted(piSessionId),
    );
    task.complete(result);
  });

  client.onTaskResume(async (task) => {
    console.log(`Resuming session ${task.sessionId}: ${task.message.substring(0, 80)}`);
    const { result } = await resumeTask(
      task.sessionId,
      task.message,
      task.projectPath,
      (action, target) => task.progress(action, target),
    );
    task.complete(result);
  });

  client.onTaskCancel((taskId) => {
    console.log(`Cancelling task: ${taskId}`);
    // task_id is device:agent:native – extract the native (pi) session id.
    const parts = taskId.split(':');
    if (parts.length >= 3) cancelTask(parts.slice(2).join(':'));
  });

  client.onGetMessages(async (req) => {
    const result = await readMessages(req.sessionId, {
      limit: req.limit,
      beforeUuid: req.beforeUuid,
      afterUuid: req.afterUuid,
    });
    return {
      messages: result.messages as MessageEntry[],
      hasMore: result.hasMore,
      oldestUuid: result.oldestUuid,
      newestUuid: result.newestUuid,
    };
  });

  client.onWatchSession((sessionId, filePath) => {
    console.log(`Watching session ${sessionId}`);
    watcher.watchSession(sessionId, filePath);
  });
  client.onUnwatchSession((sessionId) => {
    console.log(`Unwatching session ${sessionId}`);
    watcher.unwatchSession(sessionId);
  });

  client.setSessionsProvider(async () => {
    try {
      return await listReportedSessions();
    } catch (err) {
      console.warn('listReportedSessions failed:', err instanceof Error ? err.message : err);
      return [];
    }
  });

  // --- Graceful shutdown ---
  const shutdown = async () => {
    console.log('\nShutting down...');
    watcher.shutdown();
    await client.disconnect();
    config.deletePidFile();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Connect ---
  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected to CmdCtrl server.');
    console.log('Daemon is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to connect:', err instanceof Error ? err.message : err);
    config.deletePidFile();
    process.exit(1);
  }
}

async function checkPiVersion(): Promise<void> {
  const { VERSION: piSdkVersion } = await piSdk();
  // pi writes --version to stderr, so capture both streams and keep whichever
  // has content.
  const out = spawnSync(PI_BIN, ['--version'], { encoding: 'utf-8' });
  if (out.error || out.status !== 0) {
    console.warn(
      `Unable to detect pi CLI version at "${PI_BIN}": ${out.error?.message ?? `exit ${out.status}`}. ` +
        `Install @mariozechner/pi-coding-agent globally or set PI_BIN.`,
    );
    return;
  }
  const cliVersion = (out.stdout || out.stderr || '').trim();
  if (!cliVersion) return;
  if (cliVersion !== piSdkVersion) {
    console.warn(
      `pi CLI ${cliVersion} differs from bundled SDK ${piSdkVersion}. ` +
        `If session reads fail, upgrade @cmdctrl/pi to match the CLI.`,
    );
  }
}
