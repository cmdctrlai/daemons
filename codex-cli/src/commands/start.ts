import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { CodexAdapter } from '../adapter/codex-cli';
import { discoverSessions, findSessionFile, readSessionMessages } from '../session-discovery';
import { CodexSessionWatcher } from '../session-watcher';
import { forceQuitLockHolder, isThreadId } from '../adapter/thread-lock';
import { releaseLocalState } from '../lifecycle';

const configManager = new ConfigManager('codex-cli');

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

export async function start(options: StartOptions = {}): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-codex-cli register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-codex-cli stop" first.');
    process.exit(1);
  }

  if (options.detach) {
    const { pid, logFile } = configManager.spawnDetached();
    console.log(`Daemon started in background (pid ${pid}).`);
    console.log(`Logs: ${logFile}`);
    return;
  }

  const config = configManager.readConfig()!;
  const credentials = configManager.readCredentials()!;

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

  console.log('Codex CLI Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  configManager.writePidFile(process.pid);

  // Managed session IDs (started via task_start) – excluded from native discovery
  const managedSessionIds = new Set<string>();

  const sessionWatcher = new CodexSessionWatcher(
    (event) => {
      client.sendEvent('', event.type, {
        session_id: event.sessionId,
        uuid: event.uuid,
        content: event.content,
        timestamp: event.timestamp,
      });
    },
    (completion) => {
      console.log(`[Watch] Sending session_activity completion for session ${completion.sessionId.slice(-8)}`);
      client.sendSessionActivity(
        completion.sessionId,
        completion.filePath,
        completion.lastMessage,
        completion.messageCount,
        true
      );
    }
  );

  // Adapter event callback – forwards raw events to the server
  let sendEvent: (taskId: string, eventType: string, data: Record<string, unknown>) => void;

  const adapter = new CodexAdapter((taskId, eventType, data) => {
    const sessionId = data.session_id as string | undefined;
    if (eventType === 'SESSION_STARTED' && sessionId) {
      managedSessionIds.add(sessionId);
    }
    sendEvent(taskId, eventType, data);
  }, daemonVersion);

  // Shutdown and auto-update both make way for another process, so both run
  // this – an update that skipped it would leak every thread's writer lock.
  const localState = {
    unwatchAll: () => sessionWatcher.unwatchAll(),
    stopAll: () => adapter.stopAll(),
    deletePidFile: () => configManager.deletePidFile(),
  };

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'codex_cli',
    token: credentials.refreshToken,
    version: daemonVersion,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: '@cmdctrl/codex-cli',
      binName: 'cmdctrl-codex-cli',
      onBeforeUpdate: () => releaseLocalState(localState),
    },
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  // The adapter owns task lifetime, so it is the only thing that knows when an
  // update may interrupt. Without this the SDK's own set never drains and the
  // update -- and the thread release that goes with it -- is deferred forever.
  client.setRunningTasksProvider(() => adapter.getRunningTasks());

  sendEvent = (taskId, eventType, data) => {
    client.sendEvent(taskId, eventType, data);
  };

  client.onWatchSession((sessionId, filePath) => {
    sessionWatcher.watchSession(sessionId, filePath);
  });

  client.onUnwatchSession((sessionId) => {
    sessionWatcher.unwatchSession(sessionId);
  });

  client.onTaskStart(async (task) => {
    try {
      await adapter.startTask(task.taskId, task.instruction, task.projectPath);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskResume(async (task) => {
    try {
      await adapter.resumeTask(task.taskId, task.sessionId, task.message, task.projectPath);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskCancel(async (taskId) => {
    await adapter.cancelTask(taskId);
  });

  client.onGetMessages((req) => {
    return readSessionMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
  });

  // Codex hands a thread's writer lock to whichever process claimed it, and no
  // protocol method gives it back – so a session left open in a terminal is
  // unreachable from the app until that process ends. The user asks for this
  // explicitly; nothing here runs on its own.
  client.onForceQuitSession(async (sessionId) => {
    // A session we are running is never a candidate, whoever holds the lock.
    // The alternative -- identifying our own app-server by pid -- cannot work
    // through codex's npm wrapper, and getting it wrong means killing the
    // user's own in-flight turn and telling them we closed their terminal.
    // Checked again inside forceQuitLockHolder against every thread the holder
    // owns -- one codex process can hold a parent thread and its subagents,
    // and the signal takes all of them.
    if (adapter.isRunning(sessionId)) {
      console.log(`[ForceQuit] session ${sessionId.slice(-8)}: busy (ours)`);
      return { status: 'busy' };
    }
    if (!isThreadId(sessionId)) {
      return { status: 'failed', detail: 'Not a Codex session.' };
    }
    // The rollout is what makes this a session rather than a lock file with a
    // plausible name. Without it we would be willing to signal the holder of
    // any well-formed uuid under the lock directory, including threads this
    // machine's agent never created.
    if (!findSessionFile(sessionId)) {
      console.log(`[ForceQuit] session ${sessionId.slice(-8)}: unknown`);
      return { status: 'unknown_session' };
    }
    const outcome = await forceQuitLockHolder(
      sessionId,
      findSessionFile,
      (id) => adapter.isRunning(id)
    );
    console.log(`[ForceQuit] session ${sessionId.slice(-8)}: ${outcome.status}`);
    return outcome.status === 'failed'
      ? { status: 'failed', detail: outcome.reason }
      : { status: outcome.status };
  });

  // Auto-update is handled by the SDK via autoUpdateConfig above.

  const shutdown = async () => {
    console.log('\nShutting down...');
    // Disconnect first: the pid file must outlive the socket, or a restart
    // racing this shutdown would see no daemon and start a second one.
    await client.disconnect();
    await releaseLocalState(localState);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('Codex CLI daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
