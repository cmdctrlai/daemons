import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { OpenCodeAdapter, type OpenCodeCommand } from '../adapter/opencode';
import { SlashCommandRegistry } from '../slash-commands';

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

  console.log('Starting opencode server...');
  const adapter = new OpenCodeAdapter();
  await adapter.startServer();
  console.log('OpenCode server ready.\n');

  configManager.writePidFile(process.pid);

  const slashCommands = new SlashCommandRegistry(join(configManager.configDir, 'slash-commands.json'));

  // Session IDs started via task_start – excluded from native session discovery
  const managedSessionIds = new Set<string>();

  // opencode resolves commands per directory: the global built-ins and user
  // skills merged with whatever that project defines. A session only ever sees
  // its own project's set, so ask opencode once per distinct session directory
  // and record each set under that project – the API looks the set up by the
  // session's project. Resolving only the server's own directory would key every
  // command under wherever the daemon happens to run and match no session.
  // Cheap and non-fatal – the daemon runs fine without a composer menu.
  async function refreshSlashCommands(): Promise<boolean> {
    try {
      const projects = new Set<string>();
      for (const session of adapter.listSessions(managedSessionIds)) {
        if (session.project) projects.add(session.project);
      }
      // The server's own directory covers a daemon with no sessions discovered yet.
      projects.add(await adapter.getProjectDirectory());

      let changed = false;
      const known = new Map<string, OpenCodeCommand>();
      for (const project of projects) {
        if (!project) continue;
        const commands = await adapter.listCommands(project);
        for (const command of commands) known.set(command.name, command);
        if (slashCommands.record(project, commands)) changed = true;
      }
      // Every project's commands, so a leading-slash message from any session
      // routes to /command and any project's expansion can be recognised again.
      adapter.setCommands([...known.values()]);
      return changed;
    } catch (err) {
      console.warn('Could not enumerate opencode slash commands:', (err as Error).message);
      return false;
    }
  }

  // Learn the sets before connecting; the SDK reports them on connect via the provider.
  await refreshSlashCommands();

  // Track watched sessions: sessionId -> last known message count
  const watchedMessageCounts = new Map<string, number>();
  const watchIntervals = new Map<string, ReturnType<typeof setInterval>>();

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'opencode',
    token: credentials.refreshToken,
    version: daemonVersion,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: '@cmdctrl/opencode',
      binName: 'cmdctrl-opencode',
      onBeforeUpdate: () => {
        for (const interval of watchIntervals.values()) clearInterval(interval);
        watchIntervals.clear();
        adapter.stopServer();
        configManager.deletePidFile();
      },
    },
  });

  client.setSessionsProvider(() => adapter.listSessions(managedSessionIds));

  client.setSlashCommandsProvider(() => slashCommands.all());

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
    // A skill the user added since startup shows up here; re-report if so. Kept
    // out of the task's try so a report failure can't error a completed task.
    if (await refreshSlashCommands()) client.reportSlashCommands();
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

  // Auto-update is handled by the SDK via autoUpdateConfig above.

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

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('OpenCode daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
