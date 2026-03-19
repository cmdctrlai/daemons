import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { GeminiAdapter } from '../adapter/gemini-cli';
import { discoverSessions, readSessionMessages } from '../session-discovery';
import { GeminiSessionWatcher } from '../session-watcher';

const configManager = new ConfigManager('gemini-cli');

export async function start(): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-gemini-cli register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-gemini-cli stop" first.');
    process.exit(1);
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

  console.log('Gemini CLI Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  configManager.writePidFile(process.pid);

  // Managed session IDs (started via task_start) – excluded from native discovery
  const managedSessionIds = new Set<string>();

  const sessionWatcher = new GeminiSessionWatcher(
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

  const adapter = new GeminiAdapter((taskId, eventType, data) => {
    const sessionId = data.session_id as string | undefined;
    if (eventType === 'SESSION_STARTED' && sessionId) {
      managedSessionIds.add(sessionId);
    }
    sendEvent(taskId, eventType, data);
  });

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'gemini_cli',
    token: credentials.refreshToken,
    version: daemonVersion,
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

  client.onVersionStatus((msg) => {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error('  Run: cmdctrl-gemini-cli update');
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn('  Run: cmdctrl-gemini-cli update');
    }
  });

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

  console.log('Gemini CLI daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
