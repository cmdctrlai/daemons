import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, TaskHandle, ResumeHandle } from '@cmdctrl/daemon-sdk';
import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  isDaemonRunning,
} from '../config/config';
import { AiderAdapter } from '../adapter/agentapi';
import { discoverSessions, readSessionMessages, stableUuid } from '../session-discovery';
import { AiderSessionWatcher, AiderCompletionEvent } from '../session-watcher';

const configManager = {
  isRegistered,
  isDaemonRunning,
  writePidFile,
};

interface StartOptions {
  foreground?: boolean;
}

export async function start(_options: StartOptions): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-aider register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-aider stop" first.');
    process.exit(1);
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

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

  console.log('Aider Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  configManager.writePidFile(process.pid);

  // Managed session IDs (started via task_start) – excluded from native discovery
  const managedSessionIds = new Set<string>();

  const sessionWatcher = new AiderSessionWatcher(
    (event) => {
      // Skip activity events for managed sessions – their content comes via OUTPUT events
      if (managedSessionIds.has(event.sessionId)) return;
      if (event.type !== 'USER_MESSAGE') return;
      client.sendSessionActivity(event.sessionId, '', event.content, 1, false, new Date().toISOString());
    },
    (completion: AiderCompletionEvent) => {
      if (managedSessionIds.has(completion.sessionId)) return;
      client.sendSessionActivity(
        completion.sessionId,
        completion.filePath,
        completion.lastMessage,
        completion.messageCount,
        true
      );
    }
  );

  // Map from taskId → TaskHandle or ResumeHandle for event routing
  const taskHandles = new Map<string, TaskHandle | ResumeHandle>();
  // Alias: original task ID (from SSE closure) → current task ID (updated on resume)
  const taskIdAliases = new Map<string, string>();
  // Track which tasks have already had sessionStarted called
  const sessionStartedTasks = new Set<string>();

  const adapter = new AiderAdapter((taskId, eventType, data) => {
    // SSE closures capture the original taskId; follow alias chain after task_resume re-registrations
    let resolvedTaskId = taskId;
    const seen = new Set([resolvedTaskId]);
    while (taskIdAliases.has(resolvedTaskId)) {
      const next = taskIdAliases.get(resolvedTaskId)!;
      if (seen.has(next)) break;
      seen.add(next);
      resolvedTaskId = next;
    }
    const handle = taskHandles.get(resolvedTaskId);
    if (!handle) {
      console.log(`[${taskId}] Event ${eventType} with no handle (task may have completed)`);
      return;
    }
    const taskId_ = resolvedTaskId; // use resolved ID for sessionStarted tracking

    // The adapter embeds session_id in OUTPUT and TASK_COMPLETE events.
    // Intercept the first one to call sessionStarted() and resolve the PENDING ID.
    const sessionId = data.session_id as string | undefined;
    if (sessionId && 'sessionStarted' in handle && !sessionStartedTasks.has(taskId_)) {
      handle.sessionStarted(sessionId);
      managedSessionIds.add(sessionId);
      sessionStartedTasks.add(taskId_);
    }

    switch (eventType) {
      case 'OUTPUT':
        handle.output(data.output as string);
        break;
      case 'TASK_COMPLETE':
        handle.complete(data.result as string || '');
        taskHandles.delete(taskId_);
        sessionStartedTasks.delete(taskId_);
        break;
      case 'ERROR':
        handle.error(data.error as string);
        taskHandles.delete(taskId_);
        sessionStartedTasks.delete(taskId_);
        break;
      case 'WAIT_FOR_USER':
        handle.waitForUser(
          data.prompt as string,
          data.context as string || '',
          data.options as Array<{ label: string }> | undefined
        );
        break;
      default:
        console.log(`[${taskId}] Unrouted event: ${eventType}`, data);
    }
  });

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'aider',
    token: credentials.refreshToken,
    version: daemonVersion,
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  client.onWatchSession((sessionId, filePath) => {
    sessionWatcher.watchSession(sessionId, filePath);
  });

  client.onUnwatchSession((sessionId) => {
    sessionWatcher.unwatchSession(sessionId);
  });

  client.onGetMessages(async (req) => {
    // If agentapi is running for this session, merge its messages with the native session history
    const agentapiMsgs = await adapter.getMessages(req.sessionId);
    if (agentapiMsgs !== null) {
      const nativeResult = readSessionMessages(req.sessionId, 1000, undefined, undefined);
      const nativeMsgs = nativeResult.messages;

      // Convert agentapi messages: skip the aider startup banner (starts with ─ separator)
      // and any empty content. Don't rely on id=0 since messageOffset shifts ids.
      const agentapiConverted = agentapiMsgs
        .filter(m => m.content.trim() && !m.content.trim().startsWith('─'))
        .map(m => ({
          uuid: stableUuid(req.sessionId + ':agentapi:' + m.id),
          role: (m.role === 'user' ? 'USER' : 'AGENT') as 'USER' | 'AGENT',
          content: m.content.trim(),
          timestamp: m.time || new Date().toISOString(),
        }));

      const allMsgs = [...nativeMsgs, ...agentapiConverted];
      const limited = allMsgs.slice(-req.limit);
      return {
        messages: limited,
        hasMore: allMsgs.length > req.limit,
        oldestUuid: limited[0]?.uuid,
        newestUuid: limited[limited.length - 1]?.uuid,
      };
    }
    return readSessionMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
  });

  client.onTaskStart(async (task) => {
    taskHandles.set(task.taskId, task);
    try {
      await adapter.startTask(task.taskId, task.instruction, task.projectPath);
    } catch (err: unknown) {
      taskHandles.delete(task.taskId);
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskResume(async (resume) => {
    taskHandles.set(resume.taskId, resume);
    // If there's an existing agentapi process for this session under a different taskId,
    // register an alias so SSE callbacks (which close over the original taskId) route here.
    const originalTaskId = adapter.getOriginalTaskId(resume.sessionId);
    if (originalTaskId && originalTaskId !== resume.taskId) {
      taskIdAliases.set(originalTaskId, resume.taskId);
    }
    try {
      await adapter.resumeTask(resume.taskId, resume.sessionId, resume.message, resume.projectPath);
    } catch (err: unknown) {
      taskHandles.delete(resume.taskId);
      resume.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskCancel(async (taskId) => {
    taskHandles.delete(taskId);
    await adapter.cancelTask(taskId);
  });

  client.onVersionStatus((msg) => {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error('  Run: cmdctrl-aider update');
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn('  Run: cmdctrl-aider update');
    }
  });

  const shutdown = async () => {
    console.log('\nShutting down...');
    sessionWatcher.unwatchAll();
    await adapter.stopAll();
    await client.disconnect();
    const { deletePidFile } = await import('../config/config');
    deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('Aider daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
