import { readFileSync, statSync } from 'fs';
import { join } from 'path';
import { DaemonClient, ConfigManager } from '@cmdctrl/daemon-sdk';
import { CodexAdapter } from '../adapter/codex-cli';
import { discoverSessions, findSessionFile, readSessionMessages } from '../session-discovery';
import { CodexSessionWatcher } from '../session-watcher';
import { forceQuitLockHolder, isThreadId } from '../adapter/thread-lock';
import { releaseLocalState } from '../lifecycle';
import { SkillCatalog, SkillRefresher } from '../skills';

const configManager = new ConfigManager('codex-cli');

/** Skill files change in bursts; one enumeration after the burst is enough. */
const SKILLS_CHANGED_DEBOUNCE_MS = 1000;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

export async function start(options: StartOptions = {}): Promise<void> {
  if (!configManager.isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-codex-cli register" first.');
    process.exit(1);
  }

  if (configManager.isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-codex-cli stop" first.');
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
  }, daemonVersion);

  // Codex slash commands are skills, and a skill is scoped to the directory it
  // was found in, so the catalog is keyed by project and rebuilt from codex
  // rather than cached on disk – see src/skills.ts.
  const skills = new SkillCatalog();
  adapter.setSkillCatalog(skills);

  const refresher = new SkillRefresher(skills, adapter, () => {
    const projects = new Set<string>();
    for (const session of discoverSessions()) {
      if (session.project) projects.add(session.project);
    }
    // A project whose directory is gone still has rollouts on disk; asking codex
    // about it wastes a scan and would key a menu no session can reach.
    return [...projects].filter(isDirectory);
  });

  /** Enumerate a project's skills if it is new, and report if that changed anything. */
  async function ensureProjectSkills(projectPath?: string): Promise<void> {
    if (projectPath && !isDirectory(projectPath)) return;
    if (await refresher.ensureProject(projectPath)) client.reportSlashCommands();
  }

  let skillsChangedTimer: NodeJS.Timeout | null = null;
  adapter.onSkillsChanged(() => {
    // Trailing, and never rescheduled: resetting the timer on each event would
    // let a steady stream of them – a git checkout across a skills directory –
    // put the refresh off indefinitely.
    if (skillsChangedTimer) return;
    skillsChangedTimer = setTimeout(async () => {
      skillsChangedTimer = null;
      if (await refresher.refresh()) client.reportSlashCommands();
    }, SKILLS_CHANGED_DEBOUNCE_MS);
    skillsChangedTimer.unref?.();
  });

  // Shutdown and auto-update both make way for another process, so both run
  // this – an update that skipped it would leak every thread's writer lock.
  const localState = {
    unwatchAll: () => sessionWatcher.unwatchAll(),
    stopAll: () => adapter.stopAll(),
    deletePidFile: () => configManager.deletePidFile(),
  };

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'codex_cli',
    token: credentials.refreshToken,
    version: daemonVersion,
    autoUpdate: true,
    autoUpdateConfig: {
      packageName: '@cmdctrl/codex-cli',
      binName: 'cmdctrl-codex-cli',
      onBeforeUpdate: () => releaseLocalState(localState),
    },
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  client.setSlashCommandsProvider(() => skills.all());

  // The adapter owns task lifetime, so it is the only thing that knows when an
  // update may interrupt. Without this the SDK's own set never drains and the
  // update -- and the thread release that goes with it -- is deferred forever.
  client.setRunningTasksProvider(() => adapter.getRunningTasks());

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
      await ensureProjectSkills(task.projectPath);
      await adapter.startTask(task.taskId, task.instruction, task.projectPath);
    } catch (err: unknown) {
      task.error(err instanceof Error ? err.message : 'Unknown error');
    }
  });

  client.onTaskResume(async (task) => {
    try {
      await ensureProjectSkills(task.projectPath);
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

  // Codex hands a thread's writer lock to whichever process claimed it, and no
  // protocol method gives it back – so a session left open in a terminal is
  // unreachable from the app until that process ends. The user asks for this
  // explicitly; nothing here runs on its own.
  client.onForceQuitSession(async (sessionId) => {
    // A session we are running is never a candidate, whoever holds the lock.
    // The alternative -- identifying our own app-server by pid -- cannot work
    // through codex's npm wrapper, and getting it wrong means killing the
    // user's own in-flight turn and telling them we closed their terminal.
    // Checked again inside forceQuitLockHolder against every thread the holder
    // owns -- one codex process can hold a parent thread and its subagents,
    // and the signal takes all of them.
    if (adapter.isRunning(sessionId)) {
      console.log(`[ForceQuit] session ${sessionId.slice(-8)}: busy (ours)`);
      return { status: 'busy' };
    }
    if (!isThreadId(sessionId)) {
      return { status: 'failed', detail: 'Not a Codex session.' };
    }
    // The rollout is what makes this a session rather than a lock file with a
    // plausible name. Without it we would be willing to signal the holder of
    // any well-formed uuid under the lock directory, including threads this
    // machine's agent never created.
    if (!findSessionFile(sessionId)) {
      console.log(`[ForceQuit] session ${sessionId.slice(-8)}: unknown`);
      return { status: 'unknown_session' };
    }
    const outcome = await forceQuitLockHolder(
      sessionId,
      findSessionFile,
      (id) => adapter.isRunning(id)
    );
    console.log(`[ForceQuit] session ${sessionId.slice(-8)}: ${outcome.status}`);
    return outcome.status === 'failed'
      ? { status: 'failed', detail: outcome.reason }
      : { status: outcome.status };
  });

  // Auto-update is handled by the SDK via autoUpdateConfig above.

  const shutdown = async () => {
    console.log('\nShutting down...');
    if (skillsChangedTimer) clearTimeout(skillsChangedTimer);
    // Disconnect first: the pid file must outlive the socket, or a restart
    // racing this shutdown would see no daemon and start a second one.
    await client.disconnect();
    await releaseLocalState(localState);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Learn the sets before connecting; the SDK reports them on connect via the
  // provider. Nothing here is fatal, so the connection is never held up by more
  // than the enumeration's own timeout.
  await refresher.refresh();
  console.log(`Skills enumerated for ${skills.all().length} project(s).`);

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('Codex CLI daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
