import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { OpenClawAdapter, TaskCallbacks } from '../adapter/openclaw-cli';
import { discoverSessions, openclawStateDir } from '../session-discovery';
import { readMessages } from '../message-reader';

const configManager = new ConfigManager('openclaw');

export async function start(): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-openclaw register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-openclaw stop" first.');
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

  console.log('OpenClaw Daemon');
  console.log(`  Server:    ${config.serverUrl}`);
  console.log(`  Device:    ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version:   ${daemonVersion}`);
  console.log(`  State dir: ${openclawStateDir()}`);
  console.log('');

  configManager.writePidFile(process.pid);

  // Session IDs started via task_start – excluded from native session discovery
  const managedSessionIds = new Set<string>();

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'openclaw',
    token: credentials.refreshToken,
    version: daemonVersion,
  });

  const adapter = new OpenClawAdapter();

  // Report existing OpenClaw sessions from the state directory
  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  // Session watching – poll the transcript for new messages
  const watchedCounts = new Map<string, number>();
  const watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

  client.onWatchSession(async (sessionId) => {
    try {
      const { messages } = readMessages(sessionId, 1000);
      watchedCounts.set(sessionId, messages.length);
    } catch {
      watchedCounts.set(sessionId, 0);
    }

    const interval = setInterval(() => {
      try {
        const { messages } = readMessages(sessionId, 1000);
        const lastCount = watchedCounts.get(sessionId) ?? 0;
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
          watchedCounts.set(sessionId, messages.length);
        }
      } catch { /* session may be unavailable */ }
    }, 2000);

    watchIntervals.set(sessionId, interval);
  });

  client.onUnwatchSession((sessionId) => {
    const interval = watchIntervals.get(sessionId);
    if (interval) {
      clearInterval(interval);
      watchIntervals.delete(sessionId);
    }
    watchedCounts.delete(sessionId);
  });

  // Task handlers – bridge SDK task handles to the adapter
  client.onTaskStart(async (task) => {
    const callbacks: TaskCallbacks = {
      sessionStarted: (id) => {
        managedSessionIds.add(id);
        task.sessionStarted(id);
      },
      progress: (action, target) => task.progress(action, target),
      complete: (result) => task.complete(result),
      error: (msg) => task.error(msg),
    };
    adapter.startTask(task.taskId, task.instruction, callbacks, task.projectPath);
  });

  client.onTaskResume(async (task) => {
    const callbacks: TaskCallbacks = {
      sessionStarted: (id) => {
        // Resume may still need to resolve a PENDING session ID.
        // ResumeHandle doesn't have sessionStarted(), so send the
        // event directly through the client.
        console.log(`[${task.taskId}] SESSION_STARTED (resume): ${id}`);
        managedSessionIds.add(id);
        client.sendEvent(task.taskId, 'SESSION_STARTED', { session_id: id });
      },
      progress: (action, target) => task.progress(action, target),
      complete: (result) => task.complete(result),
      error: (msg) => task.error(msg),
    };
    adapter.resumeTask(task.taskId, task.sessionId, task.message, callbacks, task.projectPath);
  });

  client.onTaskCancel((taskId) => {
    adapter.cancelTask(taskId);
  });

  client.onGetMessages(async (req) => {
    return readMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
  });

  client.onVersionStatus((msg) => {
    if (msg.status === 'update_available') {
      console.warn(`Update available: v${msg.latest_version} (you have v${msg.your_version})`);
    }
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    for (const interval of watchIntervals.values()) clearInterval(interval);
    watchIntervals.clear();
    adapter.stopAll();
    await client.disconnect();
    configManager.deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('OpenClaw daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
