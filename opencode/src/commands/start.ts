import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { ActivityReporter } from '../activity';
import { OpenCodeEvents } from '../events';
import { serverFor } from '../opencode-server';
import { checkOpencode, refuseTasks } from '../opencode-version';
import { COMMAND_REFRESH_MS, CommandRefresher, SlashCommandRegistry } from '../slash-commands';
import { continuedSession, TurnManager } from '../turns';

const configManager = new ConfigManager('opencode');

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

export async function start(options: StartOptions = {}): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-opencode register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-opencode stop" first.');
    process.exit(1);
  }

  if (options.detach) {
    // The detached daemon's own output goes to its log; say it here too.
    await checkOpencode();
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

  console.log('OpenCode Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  const { version: opencode, reason: unsupported } = await checkOpencode();
  if (unsupported) {
    console.error('');
    // Connected, with auto-update on, so a release that supports this opencode reaches the device.
    configManager.writePidFile(process.pid);
    const client = newClient(config, credentials, daemonVersion, () => configManager.deletePidFile());
    refuseTasks(client, unsupported);
    await run(client, () => undefined);
  }

  console.log(opencode ? `Starting opencode ${opencode} server...` : 'Starting opencode server...');
  const { server: adapter, feed } = serverFor(opencode, configManager.configDir);
  await adapter.startServer();
  console.log('OpenCode server ready.\n');

  configManager.writePidFile(process.pid);

  const slashCommands = new SlashCommandRegistry(join(configManager.configDir, 'slash-commands.json'));

  // Session IDs started via task_start – excluded from native session discovery
  const managedSessionIds = new Set<string>();

  // Learn the sets before connecting; the SDK reports them on connect via the
  // provider. After that, a timer picks up commands the user adds.
  const commandRefresher = new CommandRefresher(adapter, slashCommands);
  await commandRefresher.refresh();

  const watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

  const stopWork = () => {
    clearInterval(commandRefreshTimer);
    events.stop();
    for (const interval of watchIntervals.values()) clearInterval(interval);
    watchIntervals.clear();
    adapter.stopServer();
  };
  const client = newClient(config, credentials, daemonVersion, () => {
    stopWork();
    configManager.deletePidFile();
  });

  const activity = new ActivityReporter(adapter, client);
  const turns = new TurnManager(adapter, {
    tool: (taskId, callId, line, tool, target) => client.sendEvent(taskId, 'VERBOSE', {
      uuid: callId,
      content: line,
      tool,
      arg_summary: target,
      timestamp: new Date().toISOString(),
    }),
    finished: (sessionId) => {
      activity.finished(sessionId).catch((err) => console.warn('Could not announce completion:', err.message));
    },
  });
  adapter.busy = (directory) => turns.busyIn(directory);
  const events = new OpenCodeEvents(adapter.url, (event) => turns.handleEvent(event), () => void turns.resync(), feed);
  events.start();

  // A turn this daemon is running is busy whatever its transcript says so far.
  client.setSessionsProvider(async () => (await adapter.listSessions(managedSessionIds))
    .map((s) => (turns.isBusy(s.session_id) ? { ...s, is_active: true } : s)));

  client.setSlashCommandsProvider(() => slashCommands.all());

  let refreshing = false;
  const commandRefreshTimer = setInterval(async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      if (await commandRefresher.refresh()) client.reportSlashCommands();
    } finally {
      refreshing = false;
    }
  }, COMMAND_REFRESH_MS);

  client.onWatchSession(async (sessionId) => {
    await activity.watch(sessionId).catch(() => undefined);
    const interval = setInterval(() => {
      activity.poll(sessionId).catch(() => { /* session may be unavailable, ignore */ });
    }, 2000);
    watchIntervals.set(sessionId, interval);
  });

  client.onUnwatchSession((sessionId) => {
    clearInterval(watchIntervals.get(sessionId));
    watchIntervals.delete(sessionId);
    activity.unwatch(sessionId);
  });

  client.onTaskStart(async (task) => {
    try {
      const existing = continuedSession(task.taskId, managedSessionIds);
      if (existing) {
        await turns.send(existing, task, task.instruction, task.images);
        return;
      }
      const sessionId = await adapter.createSession(task.projectPath);
      managedSessionIds.add(sessionId);
      task.sessionStarted(sessionId);
      await turns.send(sessionId, task, task.instruction, task.images);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskResume(async (task) => {
    try {
      await turns.send(task.sessionId, task, task.message, task.images);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  // Stop: halt the session's turn. With nothing running, still end the task so a
  // server that thinks it is running stops showing it.
  client.onSessionStop(async ({ taskId, sessionId }) => {
    if (!(await turns.stop(sessionId, taskId))) client.sendEvent(taskId, 'TASK_COMPLETE', { result: '' });
  });

  client.onGetDiff(({ sessionId }) => adapter.diff(sessionId));

  client.onGetMessages(async (req) => {
    const { messages, hasMore } = await adapter.getMessages(
      req.sessionId, req.limit, req.beforeUuid, req.afterUuid, turns.cardTime(req.afterUuid),
    );
    // What opencode is waiting on ends the newest page, as a card the app can answer.
    const ask = req.beforeUuid || hasMore ? undefined : turns.askEntry(req.sessionId);
    const fresh = ask && ask.uuid !== req.afterUuid && !messages.some((m) => m.uuid === ask.uuid);
    return { messages: fresh ? [...messages, ask] : messages, hasMore };
  });

  // Auto-update is handled by the SDK via autoUpdateConfig above.
  await run(client, stopWork);
}

function newClient(
  config: { serverUrl: string; deviceId: string },
  credentials: { refreshToken: string },
  version: string,
  onBeforeUpdate: () => void,
): DaemonClient {
  return new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'opencode',
    token: credentials.refreshToken,
    version,
    autoUpdate: true,
    autoUpdateConfig: { packageName: '@cmdctrl/opencode', binName: 'cmdctrl-opencode', onBeforeUpdate },
  });
}

/** Connect and serve until a signal: stopWork halts what the daemon runs besides the connection. */
async function run(client: DaemonClient, stopWork: () => void): Promise<never> {
  const shutdown = async () => {
    console.log('\nShutting down...');
    stopWork();
    await client.disconnect();
    configManager.deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('OpenCode daemon running. Press Ctrl+C to stop.\n');
  return new Promise<never>(() => {});
}
