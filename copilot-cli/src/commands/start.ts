import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { CopilotAdapter } from '../adapter/copilot-cli';
import { discoverSessions, readSessionMessages } from '../session-discovery';
import { CopilotSessionWatcher } from '../session-watcher';

const configManager = new ConfigManager('copilot-cli');

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

export async function start(options: StartOptions = {}): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-copilot-cli register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-copilot-cli stop" first.');
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

  console.log('Copilot CLI Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  configManager.writePidFile(process.pid);

  // Managed session IDs (started via task_start) – excluded from native discovery
  const managedSessionIds = new Set<string>();

  const sessionWatcher = new CopilotSessionWatcher(
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

  const adapter = new CopilotAdapter((taskId, eventType, data) => {
    const sessionId = data.session_id as string | undefined;
    if (eventType === 'SESSION_STARTED' && sessionId) {
      managedSessionIds.add(sessionId);
    }
    sendEvent(taskId, eventType, data);
  });

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'copilot_cli',
    token: credentials.refreshToken,
    version: daemonVersion,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: '@cmdctrl/copilot-cli',
      binName: 'cmdctrl-copilot-cli',
      onBeforeUpdate: async () => {
        sessionWatcher.unwatchAll();
        await adapter.stopAll();
        configManager.deletePidFile();
      },
    },
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

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

  console.log('Copilot CLI daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
