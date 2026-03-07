import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { OpenCodeAdapter } from '../adapter/opencode';

const configManager = new ConfigManager('opencode');

export async function start(): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-opencode register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-opencode stop" first.');
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

  console.log('OpenCode Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  console.log('Starting opencode server...');
  const adapter = new OpenCodeAdapter();
  await adapter.startServer();
  console.log('OpenCode server ready.\n');

  configManager.writePidFile(process.pid);

  // Session IDs started via task_start – excluded from native session discovery
  const managedSessionIds = new Set<string>();

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'opencode',
    token: credentials.refreshToken,
    version: daemonVersion,
  });

  client.setSessionsProvider(() => adapter.listSessions(managedSessionIds));

  // Track watched sessions: sessionId -> last known message count
  const watchedMessageCounts = new Map<string, number>();
  const watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

  client.onWatchSession(async (sessionId) => {
    try {
      const { messages } = await adapter.getMessages(sessionId, 1000);
      watchedMessageCounts.set(sessionId, messages.length);
    } catch {
      watchedMessageCounts.set(sessionId, 0);
    }

    const interval = setInterval(async () => {
      try {
        const { messages } = await adapter.getMessages(sessionId, 1000);
        const lastCount = watchedMessageCounts.get(sessionId) ?? 0;
        if (messages.length > lastCount) {
          const newest = messages[messages.length - 1];
          const isCompletion = newest.role === 'AGENT';
          client.sendSessionActivity(
            sessionId,
            '',
            newest.content,
            messages.length,
            isCompletion,
            newest.timestamp,
          );
          watchedMessageCounts.set(sessionId, messages.length);
        }
      } catch { /* session may be unavailable, ignore */ }
    }, 2000);

    watchIntervals.set(sessionId, interval);
  });

  client.onUnwatchSession((sessionId) => {
    const interval = watchIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      watchIntervals.delete(sessionId);
    }
    watchedMessageCounts.delete(sessionId);
  });

  client.onTaskStart(async (task) => {
    try {
      const sessionId = await adapter.createSession();
      managedSessionIds.add(sessionId);
      task.sessionStarted(sessionId);
      const result = await adapter.sendMessage(sessionId, task.instruction);
      task.complete(result);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskResume(async (task) => {
    try {
      const result = await adapter.sendMessage(task.sessionId, task.message);
      task.complete(result);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onGetMessages(async (req) => {
    const { messages, hasMore } = await adapter.getMessages(req.sessionId, req.limit);
    return { messages, hasMore };
  });

  client.onVersionStatus((msg) => {
    if (msg.status === 'update_available') {
      console.warn(`Update available: v${msg.latest_version} (you have v${msg.your_version})`);
    }
  });

  const shutdown = async () => {
    console.log('\nShutting down...');
    for (const interval of watchIntervals.values()) clearInterval(interval);
    watchIntervals.clear();
    adapter.stopServer();
    await client.disconnect();
    configManager.deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
    console.log('OpenCode daemon running. Press Ctrl+C to stop.\n');
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to connect:', err);
    adapter.stopServer();
    process.exit(1);
  }
}
