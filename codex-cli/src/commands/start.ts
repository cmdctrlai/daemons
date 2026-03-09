import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { CodexAdapter } from '../adapter/codex-cli';
import { discoverSessions, readSessionMessages } from '../session-discovery';
import { CodexSessionWatcher } from '../session-watcher';

const configManager = new ConfigManager('codex-cli');

export async function start(): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-codex-cli register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-codex-cli stop" first.');
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
  });

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'codex_cli',
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
      console.error('  Run: cmdctrl-codex-cli update');
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn('  Run: cmdctrl-codex-cli update');
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

  try {
    await client.connect();
    console.log('Codex CLI daemon running. Press Ctrl+C to stop.\n');
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}
