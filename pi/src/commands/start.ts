/**
 * Start command – connect to the CmdCtrl server and run as a daemon.
 *
 * Wires the `pi` CLI (via `../agent.ts`) to the SDK's DaemonClient. Session
 * storage and message history both live in pi's native session files under
 * `~/.pi/agent/sessions/` – there is no daemon-side store. See
 * `../session-reader.ts` and `../session-watcher.ts`.
 */

import { spawnSync } from 'child_process';
import { join } from 'path';
import {
  DaemonClient,
  type MessageEntry,
} from '@cmdctrl/daemon-sdk';
import { AGENT_TYPE, DAEMON_VERSION, PI_BIN, config } from '../context';
import { piSdk } from '../pi-sdk';
import { startTask, resumeTask, cancelTask } from '../agent';
import { readMessages, listReportedSessions, resolveSessionPath } from '../session-reader';
import { listCommands, type PiCommand } from '../pi-commands';
import { SlashCommandRegistry } from '../slash-commands';
import { CommandCollapser } from '../command-collapse';
import {
  SessionWatcher,
  type AgentResponseEvent,
  type VerboseEvent,
  type CompletionEvent,
} from '../session-watcher';

/**
 * How many projects to enumerate commands for at startup, most recently active
 * first. Each costs a short-lived pi process, and a user with a long session
 * history should not pay for all of it before the menu of the one project they
 * are looking at is ready – the rest arrive as those sessions are opened.
 */
const STARTUP_PROJECT_LIMIT = 10;

/** Don't re-probe a project more often than this when sessions are opened. */
const PROJECT_REFRESH_INTERVAL_MS = 60_000;

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

export async function start(options: StartOptions = {}): Promise<void> {
  if (!config.isRegistered()) {
    console.error('Not registered. Run: cmdctrl-pi register -s <server-url>');
    process.exit(1);
  }
  if (config.isDaemonRunning()) {
    console.error('Daemon is already running.');
    process.exit(1);
  }

  if (options.detach) {
    const { pid, logFile } = config.spawnDetached();
    console.log(`Daemon started in background (pid ${pid}).`);
    console.log(`Logs: ${logFile}`);
    return;
  }

  const cfg = config.readConfig()!;
  const creds = config.readCredentials()!;

  console.log(`Starting daemon for device "${cfg.deviceName}"...`);
  console.log(`Server: ${cfg.serverUrl}`);

  await checkPiVersion();

  config.writePidFile(process.pid);

  // --- Slash commands ---
  // pi resolves its command set per working directory: the user's global prompts,
  // skills and extensions merged with whatever that project defines. A session
  // only ever sees its own project's set, so ask pi once per project directory and
  // record each set under that project – the API looks the set up by the session's
  // project. Probing only wherever the daemon happens to run would key every
  // command under that one path and match no session.
  const slashCommands = new SlashCommandRegistry(join(config.configDir, 'slash-commands.json'));
  const collapser = new CommandCollapser();
  // Templates from every project, so any project's expansion can be recognised.
  const knownCommands = new Map<string, PiCommand>();
  const lastProbed = new Map<string, number>();

  async function refreshSlashCommands(projects: Iterable<string>): Promise<boolean> {
    let changed = false;
    for (const project of new Set(projects)) {
      if (!project) continue;
      const previous = lastProbed.get(project);
      if (previous !== undefined && Date.now() - previous < PROJECT_REFRESH_INTERVAL_MS) continue;
      lastProbed.set(project, Date.now());
      try {
        const commands = await listCommands(project);
        for (const command of commands) knownCommands.set(command.name, command);
        if (slashCommands.record(project, commands)) changed = true;
      } catch (err) {
        // A composer menu is worth a warning, never a failed daemon.
        console.warn(
          `Could not enumerate pi slash commands for ${project}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    collapser.setCommands([...knownCommands.values()]);
    return changed;
  }

  /** The projects of the most recently active sessions – where a menu is wanted first. */
  async function recentProjects(): Promise<string[]> {
    const sessions = await listReportedSessions();
    const projects: string[] = [];
    const seen = new Set<string>();
    for (const session of sessions.sort((a, b) => b.last_activity.localeCompare(a.last_activity))) {
      if (!session.project || seen.has(session.project)) continue;
      seen.add(session.project);
      projects.push(session.project);
      if (projects.length >= STARTUP_PROJECT_LIMIT) break;
    }
    return projects;
  }

  // --- SDK client ---
  const client = new DaemonClient({
    serverUrl: cfg.serverUrl,
    deviceId: cfg.deviceId,
    agentType: AGENT_TYPE,
    token: creds.refreshToken,
    version: DAEMON_VERSION,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: '@cmdctrl/pi',
      binName: 'cmdctrl-pi',
      onBeforeUpdate: () => {
        config.deletePidFile();
      },
    },
  });

  // --- Session watcher. Emits events for active observers of a session. ---
  const watcher = new SessionWatcher(
    {
      onAgentResponse: (ev: AgentResponseEvent) => {
        // task_id is empty for watcher-emitted events: the data is file-derived,
        // not tied to a currently-running task (may arrive mid-run or long after).
        client.sendEvent('', 'AGENT_RESPONSE', {
          session_id: ev.sessionId,
          uuid: ev.uuid,
          content: ev.content,
          timestamp: ev.timestamp,
        });
      },
      onVerbose: (ev: VerboseEvent) => {
        client.sendEvent('', 'VERBOSE', {
          session_id: ev.sessionId,
          uuid: ev.uuid,
          kind: ev.kind,
          content: ev.summary,
          timestamp: ev.timestamp,
        });
      },
      onCompletion: (ev: CompletionEvent) => {
        client.sendSessionActivity(
          ev.sessionId,
          ev.filePath,
          ev.lastMessage,
          ev.messageCount,
          true,
        );
      },
    },
    collapser,
  );

  // --- Handlers ---
  client.onTaskStart(async (task) => {
    console.log(`Starting task: ${task.instruction.substring(0, 80)}`);
    const { result } = await startTask(
      task.instruction,
      task.projectPath,
      (action, target) => task.progress(action, target),
      (piSessionId) => task.sessionStarted(piSessionId),
    );
    task.complete(result);
    // A template or skill the user added since startup shows up here. Kept out of
    // the task itself so a probe failure can't error a completed task.
    if (task.projectPath && await refreshSlashCommands([task.projectPath])) {
      client.reportSlashCommands();
    }
  });

  client.onTaskResume(async (task) => {
    console.log(`Resuming session ${task.sessionId}: ${task.message.substring(0, 80)}`);
    const { result } = await resumeTask(
      task.sessionId,
      task.message,
      task.projectPath,
      (action, target) => task.progress(action, target),
    );
    task.complete(result);
    if (task.projectPath && await refreshSlashCommands([task.projectPath])) {
      client.reportSlashCommands();
    }
  });

  client.onTaskCancel((taskId) => {
    console.log(`Cancelling task: ${taskId}`);
    // task_id is device:agent:native – extract the native (pi) session id.
    const parts = taskId.split(':');
    if (parts.length >= 3) cancelTask(parts.slice(2).join(':'));
  });

  client.onGetMessages(async (req) => {
    const result = await readMessages(req.sessionId, {
      limit: req.limit,
      beforeUuid: req.beforeUuid,
      afterUuid: req.afterUuid,
      collapser,
    });
    return {
      messages: result.messages as MessageEntry[],
      hasMore: result.hasMore,
      oldestUuid: result.oldestUuid,
      newestUuid: result.newestUuid,
    };
  });

  client.onWatchSession((sessionId, filePath) => {
    console.log(`Watching session ${sessionId}`);
    watcher.watchSession(sessionId, filePath);
    // Opening a session in a pane is when its composer menu is wanted, and the
    // only point at which the daemon learns that project matters. Off the critical
    // path: the pane works with or without a menu.
    void (async () => {
      const info = await resolveSessionPath(sessionId);
      if (info?.cwd && await refreshSlashCommands([info.cwd])) client.reportSlashCommands();
    })().catch(() => { /* a missing session is not a watch failure */ });
  });
  client.onUnwatchSession((sessionId) => {
    console.log(`Unwatching session ${sessionId}`);
    watcher.unwatchSession(sessionId);
  });

  client.setSessionsProvider(async () => {
    try {
      return await listReportedSessions(collapser);
    } catch (err) {
      console.warn('listReportedSessions failed:', err instanceof Error ? err.message : err);
      return [];
    }
  });

  client.setSlashCommandsProvider(() => slashCommands.all());

  // --- Graceful shutdown ---
  const shutdown = async () => {
    console.log('\nShutting down...');
    watcher.shutdown();
    await client.disconnect();
    config.deletePidFile();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Learn the sets before connecting, so the report the SDK sends on connect is
  // already right and the first session list is titled with commands rather than
  // their expansions.
  await refreshSlashCommands(await recentProjects().catch(() => []));

  // --- Connect ---
  try {
    console.log('Connecting...');
    await client.connect();
    console.log('Connected to CmdCtrl server.');
    console.log('Daemon is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to connect:', err instanceof Error ? err.message : err);
    config.deletePidFile();
    process.exit(1);
  }
}

async function checkPiVersion(): Promise<void> {
  const { VERSION: piSdkVersion } = await piSdk();
  // pi writes --version to stderr, so capture both streams and keep whichever
  // has content.
  const out = spawnSync(PI_BIN, ['--version'], { encoding: 'utf-8' });
  if (out.error || out.status !== 0) {
    console.warn(
      `Unable to detect pi CLI version at "${PI_BIN}": ${out.error?.message ?? `exit ${out.status}`}. ` +
        `Install @mariozechner/pi-coding-agent globally or set PI_BIN.`,
    );
    return;
  }
  const cliVersion = (out.stdout || out.stderr || '').trim();
  if (!cliVersion) return;
  if (cliVersion !== piSdkVersion) {
    console.warn(
      `pi CLI ${cliVersion} differs from bundled SDK ${piSdkVersion}. ` +
        `If session reads fail, upgrade @cmdctrl/pi to match the CLI.`,
    );
  }
}
