import { readFileSync } from 'fs';
import { join } from 'path';
import { DaemonClient } from '@cmdctrl/daemon-sdk';
import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  deletePidFile,
  isDaemonRunning,
  vscodeStorageExists,
} from '../config/config';
import { getCDPClient } from '../adapter/cdp-client';
import { getSessionWatcher, CopilotSession, ChatMessage } from '../adapter/session-watcher';
import { discoverSessions } from '../session-discovery';
import { MessageEntry } from '@cmdctrl/daemon-sdk';

interface StartOptions {
  foreground?: boolean;
}

export async function start(options: StartOptions): Promise<void> {
  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-vscode-copilot register" first.');
    process.exit(1);
  }

  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-vscode-copilot stop" first.');
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

  console.log('VS Code Copilot Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  if (!vscodeStorageExists()) {
    console.warn('Warning: VS Code workspace storage not found. Make sure VS Code has been run at least once.');
  }

  const cdp = getCDPClient();
  const cdpAvailable = await cdp.isAvailable();
  if (!cdpAvailable) {
    console.warn('Warning: VS Code CDP not available.');
    console.warn('To enable message injection, start VS Code with:');
    console.warn('  code --remote-debugging-port=9223');
    console.warn('Continuing with observation-only mode...\n');
  } else {
    console.log('CDP: Connected to VS Code');
    const title = await cdp.getWindowTitle();
    if (title) console.log(`  Active project: ${title}`);
    console.log('');
  }

  writePidFile(process.pid);

  const managedSessionIds = new Set<string>();
  const watchedSessions = new Set<string>();

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'vscode_copilot',
    token: credentials.refreshToken,
    version: daemonVersion,
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  // Session watcher – chokidar-based file watching of VS Code chat JSON files
  const sessionWatcher = getSessionWatcher();

  sessionWatcher.on('session:updated', (session: CopilotSession, newMessages: ChatMessage[]) => {
    if (!watchedSessions.has(session.sessionId)) return;
    const lastMessage = newMessages[newMessages.length - 1];
    const isCompletion = !!lastMessage?.response;
    const userMessageUuid = session.messages.slice().reverse().find(m => m.text)?.requestId;

    // Send thinking steps as verbose output before the completion.
    // task_id must be empty so the backend resolves the native session_id to its canonical ID.
    if (isCompletion && lastMessage.thinkingContent) {
      client.sendEvent('', 'OUTPUT', {
        session_id: session.sessionId,
        output: lastMessage.thinkingContent,
        user_message_uuid: userMessageUuid,
      });
    }

    client.sendSessionActivity(
      session.sessionId,
      session.workspacePath,
      isCompletion ? lastMessage.response : (lastMessage?.text || ''),
      session.messages.length,
      isCompletion,
      undefined,
      userMessageUuid,
    );
  });

  sessionWatcher.start();

  client.onWatchSession((sessionId) => {
    watchedSessions.add(sessionId);
  });

  client.onUnwatchSession((sessionId) => {
    watchedSessions.delete(sessionId);
  });

  client.onGetMessages((req) => {
    const session = sessionWatcher.getSession(req.sessionId);
    if (!session) {
      return { messages: [], hasMore: false };
    }

    // Build flat message list from request-response pairs
    const messages: MessageEntry[] = [];
    for (const m of session.messages) {
      messages.push({
        uuid: m.requestId + '-user',
        role: 'USER',
        content: m.text,
        timestamp: new Date(m.timestamp).toISOString(),
      });
      if (m.response) {
        messages.push({
          uuid: m.requestId + '-assistant',
          role: 'AGENT',
          content: m.response,
          timestamp: new Date(m.timestamp).toISOString(),
        });
      }
    }

    // Pagination
    let result = messages;
    let hasMore = false;

    if (req.afterUuid) {
      const afterIdx = messages.findIndex(m => m.uuid === req.afterUuid);
      if (afterIdx !== -1) {
        result = messages.slice(afterIdx + 1, afterIdx + 1 + req.limit);
        hasMore = afterIdx + 1 + req.limit < messages.length;
        return {
          messages: result,
          hasMore,
          oldestUuid: result[0]?.uuid,
          newestUuid: result[result.length - 1]?.uuid,
        };
      }
    }

    if (req.beforeUuid) {
      const idx = messages.findIndex(m => m.uuid === req.beforeUuid);
      if (idx > 0) result = messages.slice(0, idx);
    }

    if (result.length > req.limit) {
      hasMore = true;
      result = result.slice(-req.limit);
    }

    return {
      messages: result,
      hasMore,
      oldestUuid: result[0]?.uuid,
      newestUuid: result[result.length - 1]?.uuid,
    };
  });

  client.onTaskStart(async (task) => {
    const cdpClient = getCDPClient();
    const available = await cdpClient.isAvailable();
    if (!available) {
      task.error('VS Code not available. Please start VS Code with: code --remote-debugging-port=9223');
      return;
    }

    try {
      await cdpClient.connect();

      const chatOpen = await cdpClient.isChatOpen();
      if (!chatOpen) {
        await cdpClient.openChatPanel();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Snapshot sessions before sending to detect which one receives the message
      const beforeSessions = new Map<string, number>();
      for (const s of sessionWatcher.getSessions()) {
        beforeSessions.set(s.sessionId, s.lastMessageDate);
      }

      const success = await cdpClient.sendMessage(task.instruction);
      if (!success) {
        task.error('Failed to send message to Copilot');
        return;
      }

      // Wait for session discovery via chokidar events
      const discoveredSessionId = await new Promise<string>((resolve) => {
        const timeout = setTimeout(() => {
          sessionWatcher.removeListener('session:discovered', onDiscovered);
          sessionWatcher.removeListener('session:updated', onUpdated);
          console.warn('[TaskStart] Could not discover session ID after 15s');
          resolve('');
        }, 15000);

        const onDiscovered = (session: CopilotSession) => {
          if (!beforeSessions.has(session.sessionId)) {
            clearTimeout(timeout);
            sessionWatcher.removeListener('session:discovered', onDiscovered);
            sessionWatcher.removeListener('session:updated', onUpdated);
            resolve(session.sessionId);
          }
        };

        const onUpdated = (session: CopilotSession) => {
          const prevDate = beforeSessions.get(session.sessionId);
          if (prevDate !== undefined && session.lastMessageDate > prevDate) {
            clearTimeout(timeout);
            sessionWatcher.removeListener('session:discovered', onDiscovered);
            sessionWatcher.removeListener('session:updated', onUpdated);
            resolve(session.sessionId);
          }
        };

        sessionWatcher.on('session:discovered', onDiscovered);
        sessionWatcher.on('session:updated', onUpdated);
      });

      if (discoveredSessionId) {
        managedSessionIds.add(discoveredSessionId);
        task.sessionStarted(discoveredSessionId);
      }

      task.complete('Message sent to Copilot');
    } catch (err) {
      task.error((err as Error).message);
    }
  });

  client.onTaskResume(async (task) => {
    const cdpClient = getCDPClient();
    try {
      await cdpClient.connect();
      const success = await cdpClient.sendMessage(task.message);
      if (success) {
        task.complete('Follow-up message sent to Copilot');
      } else {
        task.error('Failed to send follow-up message to Copilot');
      }
    } catch (err) {
      task.error((err as Error).message);
    }
  });

  client.onTaskCancel(async (taskId) => {
    console.log(`Task cancel requested for ${taskId} (not implemented for VS Code)`);
  });

  client.onVersionStatus((msg) => {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error('  Run: cmdctrl-vscode-copilot update');
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn('  Run: cmdctrl-vscode-copilot update');
    }
  });

  const shutdown = async () => {
    console.log('\nShutting down...');
    await sessionWatcher.stop();
    getCDPClient().disconnect();
    await client.disconnect();
    deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (options.foreground !== undefined) {
    // foreground flag acknowledged – daemon always runs in foreground
  }

  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  console.log('VS Code Copilot daemon running. Press Ctrl+C to stop.\n');
  await new Promise(() => {});
}
