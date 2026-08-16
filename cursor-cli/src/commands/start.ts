import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { CursorAdapter } from '../adapter/cursor-cli';
import { discoverSessions, readSessionMessages } from '../session-discovery';
import { CursorSessionWatcher } from '../session-watcher';

const configManager = new ConfigManager('cursor-cli');

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

export async function start(options: StartOptions = {}): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-cursor-cli register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-cursor-cli stop" first.');
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

  console.log('Cursor CLI Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  configManager.writePidFile(process.pid);

  // Managed session IDs (started via task_start) – excluded from native discovery
  const managedSessionIds = new Set<string>();

  const sessionWatcher = new CursorSessionWatcher(
    (event) => {
      // Only send activity for user messages – agent responses are the final
      // answer already shown via the transcript; sending them here duplicates.
      if (event.type !== 'USER_MESSAGE') return;
      client.sendSessionActivity(
        event.sessionId,
        '',
        event.content,
        1,
        false,
        new Date().toISOString()
      );
    },
    (completion) => {
      client.sendSessionActivity(
        completion.sessionId,
        completion.filePath,
        completion.lastMessage,
        completion.messageCount,
        true
      );
    }
  );

  // Event callback wired into the DaemonClient below
  let sendEvent: (taskId: string, eventType: string, data: Record<string, unknown>) => void;

  const adapter = new CursorAdapter((taskId, eventType, data) => {
    const sessionId = data.session_id as string | undefined;

    if (eventType === 'SESSION_STARTED' && sessionId) {
      managedSessionIds.add(sessionId);
    }

    sendEvent(taskId, eventType, data);
  });

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'cursor_cli',
    token: credentials.refreshToken,
    version: daemonVersion,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: '@cmdctrl/cursor-cli',
      binName: 'cmdctrl-cursor-cli',
      onBeforeUpdate: async () => {
        sessionWatcher.unwatchAll();
        await adapter.stopAll();
        configManager.deletePidFile();
      },
    },
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  sendEvent = (taskId, eventType, data) => {
    // cursor-agent writes all content to transcript files – suppress OUTPUT events
    // and strip result from TASK_COMPLETE to avoid duplicating transcript content.
    if (eventType === 'OUTPUT') return;
    if (eventType === 'TASK_COMPLETE') data = { ...data, result: '' };
    (client as any).send({
      type: 'event',
      task_id: taskId,
      event_type: eventType,
      ...data,
    });
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

  // cursor-agent always writes to transcript files – use them as the single source of truth
  client.onGetMessages((req) => {
    return readSessionMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
  });

  // Auto-update is handled by the SDK via autoUpdateConfig above.

  const shutdown = async () => {
    console.log('\nShutting down...');
    sessionWatcher.unwatchAll();
    await adapter.stopAll();
    await client.disconnect();
    configManager.deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('Cursor CLI daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
