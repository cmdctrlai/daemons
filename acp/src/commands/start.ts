/**
 * Start – connect to the CmdCtrl server and serve sessions on the registered
 * ACP agent. See `../turns.ts` for how a turn is relayed.
 */
import * as os from 'os';
import { join } from 'path';
import { DaemonClient } from '@cmdctrl/daemon-sdk';
import type { AcpSessionInfo } from '../acp/types';
import { AcpAgent } from '../agent';
import { parseCommandLine } from '../command-line';
import { AGENT_TYPE, BIN_NAME, DAEMON_VERSION, INSTANCE_ENV, PACKAGE_NAME, commandFor, configFor, readAcpConfig, startInstance } from '../context';
import { continuedSession, projectDir, reportedSessions } from '../sessions';
import { TranscriptStore } from '../transcript';
import { TurnManager } from '../turns';

/** How many project folders to ask an agent that only lists one folder's sessions at a time. */
const LISTED_PROJECTS = 20;

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
  instance?: string;
}

export async function start(options: StartOptions = {}): Promise<void> {
  const instance = startInstance(options.instance);
  // The SDK respawns `cmdctrl-acp start` after an auto-update; this is how it finds the instance again.
  if (instance) process.env[INSTANCE_ENV] = instance;
  const config = configFor(instance);
  const cfg = readAcpConfig(config);
  if (!config.isRegistered() || !cfg) {
    console.error(`Not registered. Run: ${commandFor('register', instance)} --agent "<command>" -s <server-url>`);
    process.exit(1);
  }
  if (config.isDaemonRunning()) {
    console.error(`Daemon is already running. Run "${commandFor('stop', instance)}" first.`);
    process.exit(1);
  }
  if (options.detach) {
    const { pid, logFile } = config.spawnDetached();
    console.log(`Daemon started in background (pid ${pid}).`);
    console.log(`Logs: ${logFile}`);
    return;
  }

  const creds = config.readCredentials()!;
  const argv = parseCommandLine(cfg.agentCommand);
  console.log(`ACP daemon ${DAEMON_VERSION} for device "${cfg.deviceName}"`);
  console.log(`  Server: ${cfg.serverUrl}`);
  console.log(`  Agent:  ${cfg.agentCommand}`);
  config.writePidFile(process.pid);

  const transcript = new TranscriptStore(join(config.configDir, 'transcripts'));
  let turns: TurnManager;
  const agent = new AcpAgent(argv, {
    update: (notification) => turns.handleUpdate(notification),
    permission: (request, id) => turns.permission(request, id),
    requestWithdrawn: (id) => turns.withdraw(id),
    exited: (reason) => turns.agentExited(reason),
  }, DAEMON_VERSION);

  const client = new DaemonClient({
    serverUrl: cfg.serverUrl,
    deviceId: cfg.deviceId,
    agentType: AGENT_TYPE,
    token: creds.refreshToken,
    version: DAEMON_VERSION,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: PACKAGE_NAME,
      binName: BIN_NAME,
      onBeforeUpdate: () => {
        agent.stop();
        config.deletePidFile();
      },
    },
  });

  turns = new TurnManager(agent, transcript, {
    // task_id is empty: the server finds the conversation by the native session id.
    agentText: (sessionId, entry) => client.sendEvent('', 'AGENT_RESPONSE', {
      session_id: sessionId, uuid: entry.uuid, content: entry.content, timestamp: entry.timestamp,
    }),
    tool: (taskId, callId, line, tool, target) => client.sendEvent(taskId, 'VERBOSE', {
      uuid: callId, content: line, tool, arg_summary: target, timestamp: new Date().toISOString(),
    }),
    finished: (sessionId, lastMessage, count) => client.sendSessionActivity(sessionId, '', lastMessage, count, true),
    // The server tells apps the agent is working on SESSION_STARTED, as claude-code sends for each turn.
    working: (taskId, sessionId) => client.sendEvent(taskId, 'SESSION_STARTED', { session_id: sessionId }),
  });

  /** The agent's own list, as of the last report – where a listed session's folder comes from. */
  let listed: AcpSessionInfo[] = [];
  const cwdOf = (sessionId: string, hint?: string): string =>
    transcript.get(sessionId)?.cwd || listed.find((s) => s.sessionId === sessionId)?.cwd || safeProjectDir(hint);

  /** Project folders with sessions here, most recent first: where an agent that lists per folder is asked. */
  const knownProjects = (): string[] => [...new Set(transcript.list()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((r) => r.cwd)
    .filter(Boolean))].slice(0, LISTED_PROJECTS);

  client.onTaskStart(async (task) => {
    try {
      const existing = continuedSession(task.taskId);
      if (existing) {
        await turns.send(existing, cwdOf(existing, task.projectPath), task, task.instruction, task.images);
        return;
      }
      const cwd = projectDir(task.projectPath);
      const sessionId = await agent.newSession(cwd);
      task.sessionStarted(sessionId);
      await turns.send(sessionId, cwd, task, task.instruction, task.images);
    } catch (err) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskResume(async (task) => {
    try {
      await turns.send(task.sessionId, cwdOf(task.sessionId, task.projectPath), task, task.message, task.images);
    } catch (err) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  // Stop: cancel the session's prompt. With nothing running, still end the task so a
  // server that thinks it is running stops showing it.
  client.onSessionStop(async ({ taskId, sessionId }) => {
    if (!(await turns.stop(sessionId, taskId))) client.sendEvent(taskId, 'TASK_COMPLETE', { result: '' });
  });

  client.onTaskCancel((taskId) => {
    void turns.stop(taskId.split(':').slice(2).join(':'), taskId);
  });

  client.onGetMessages(async (req) => {
    try {
      await turns.refresh(req.sessionId, cwdOf(req.sessionId));
    } catch (err) {
      console.warn(`Could not replay ${req.sessionId} from the agent: ${(err as Error).message}`);
    }
    const page = transcript.page(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
    return { messages: page.messages, hasMore: page.hasMore, oldestUuid: page.oldestUuid, newestUuid: page.newestUuid };
  });

  client.setSessionsProvider(async () => {
    // Only ask a running agent: a broken command shouldn't respawn every 30 seconds.
    if (agent.running) {
      try {
        listed = await agent.listSessions(knownProjects());
      } catch (err) {
        console.warn(`session/list failed: ${(err as Error).message}`);
      }
    }
    return reportedSessions(transcript.list(), listed, (id) => turns.isBusy(id));
  });

  const shutdown = async () => {
    console.log('\nShutting down...');
    // Messages still waiting are told they weren't sent before the connection goes.
    turns.shutdown();
    agent.stop();
    await client.disconnect();
    config.deletePidFile();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Starting the agent up front surfaces a broken command in the log at once; a
  // failure here is retried on the next message.
  try {
    await agent.start();
    listed = await agent.listSessions(knownProjects()).catch(() => []);
  } catch (err) {
    console.error(`The agent did not start: ${(err as Error).message}`);
    console.error('The daemon stays connected and tries again on the next message.');
  }

  client.connect().catch(() => console.warn('Initial connection failed, will retry...'));
  console.log(`ACP daemon running. Press Ctrl+C to stop.${instance ? ` (instance ${instance})` : ''}\n`);
  await new Promise(() => {});
}

function safeProjectDir(hint: string | undefined): string {
  try {
    return projectDir(hint);
  } catch {
    return os.homedir();
  }
}
