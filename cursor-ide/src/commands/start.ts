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
  cursorDbExists,
} from '../config/config';
import { getCDPClient } from '../adapter/cdp-client';
import { getCursorDB } from '../adapter/cursor-db';
import { discoverSessions } from '../session-discovery';
import { getSessionWatcher } from '../session-watcher';

interface StartOptions {
  foreground?: boolean;
}

export async function start(options: StartOptions): Promise<void> {
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] Unhandled promise rejection:', reason);
    process.exit(1);
  });

  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-cursor-ide register" first.');
    process.exit(1);
  }

  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-cursor-ide stop" first.');
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

  console.log('Cursor IDE Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log(`  Version: ${daemonVersion}`);
  console.log('');

  if (!cursorDbExists()) {
    console.warn('Warning: Cursor database not found. Make sure Cursor has been run at least once.');
  }

  const cdp = getCDPClient();
  const cdpAvailable = await cdp.isAvailable();
  if (!cdpAvailable) {
    console.warn('Warning: Cursor CDP not available.');
    console.warn('To enable message injection, start Cursor with:');
    console.warn('  /Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222');
    console.warn('Continuing with observation-only mode...\n');
  } else {
    console.log('CDP: Connected to Cursor');
    const title = await cdp.getWindowTitle();
    if (title) console.log(`  Active project: ${title}`);
    console.log('');
  }

  writePidFile(process.pid);

  const managedSessionIds = new Set<string>();

  const client = new DaemonClient({
    serverUrl: config.serverUrl,
    deviceId: config.deviceId,
    agentType: 'cursor_ide',
    token: credentials.refreshToken,
    version: daemonVersion,
  });

  client.setSessionsProvider(() => discoverSessions(managedSessionIds));

  // Session watcher – polls SQLite for changes and forwards to server
  const watcher = getSessionWatcher();
  watcher.start((event) => {
    client.sendSessionActivity(
      event.session_id,
      event.file_path,
      event.last_message,
      event.message_count,
      event.is_completion,
      undefined,
      event.user_message_uuid,
    );
  });

  client.onWatchSession((sessionId) => {
    watcher.watchSession(sessionId);
  });

  client.onUnwatchSession((sessionId) => {
    watcher.unwatchSession(sessionId);
  });

  client.onGetMessages((req) => {
    const cursorDb = getCursorDB();
    return cursorDb.getMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
  });

  client.onTaskStart(async (task) => {
    const cdpClient = getCDPClient();
    const available = await cdpClient.isAvailable();
    if (!available) {
      task.error('Cursor not available. Please start Cursor with: /Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222');
      return;
    }

    try {
      await cdpClient.connect();

      const composerOpen = await cdpClient.isComposerOpen();
      if (!composerOpen) {
        await cdpClient.toggleComposer();
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Snapshot bubble counts to identify which composer receives the message
      const cursorDb = getCursorDB();
      const beforeBubbleCounts = new Map<string, number>();
      for (const c of cursorDb.getComposers()) {
        beforeBubbleCounts.set(c.composerId, cursorDb.getBubbleCount(c.composerId));
      }

      const success = await cdpClient.sendMessage(task.instruction);
      if (!success) {
        task.error('Failed to send message to Cursor');
        return;
      }

      // Poll to discover which session received the message
      let discoveredSessionId = '';
      for (let attempt = 0; attempt < 20; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        for (const c of cursorDb.getComposers()) {
          const prevCount = beforeBubbleCounts.get(c.composerId);
          const currentCount = cursorDb.getBubbleCount(c.composerId);
          if (prevCount === undefined || currentCount > prevCount) {
            discoveredSessionId = c.composerId;
            break;
          }
        }
        if (discoveredSessionId) break;
      }

      if (discoveredSessionId) {
        managedSessionIds.add(discoveredSessionId);
        task.sessionStarted(discoveredSessionId);
      } else {
        console.warn('[TaskStart] Could not discover session ID after 10s');
      }

      task.complete('Message sent to Cursor');
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
        task.complete('Follow-up message sent to Cursor');
      } else {
        task.error('Failed to send follow-up message to Cursor');
      }
    } catch (err) {
      task.error((err as Error).message);
    }
  });

  client.onTaskCancel(async (taskId) => {
    console.log(`Task cancel requested for ${taskId} (not implemented for Cursor)`);
  });

  client.onVersionStatus((msg) => {
    if (msg.status === 'update_required') {
      console.error(`\n✖ Daemon version ${msg.your_version} is no longer supported (minimum: ${msg.min_version})`);
      console.error('  Run: cmdctrl-cursor-ide update');
      process.exit(1);
    } else if (msg.status === 'update_available') {
      console.warn(`\n⚠ Update available: v${msg.latest_version} (you have v${msg.your_version})`);
      console.warn('  Run: cmdctrl-cursor-ide update');
    }
  });

  const shutdown = async () => {
    console.log('\nShutting down...');
    watcher.stop();
    getCDPClient().disconnect();
    getCursorDB().close();
    await client.disconnect();
    deletePidFile();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (options.foreground !== undefined) {
    // foreground flag acknowledged – daemon always runs in foreground
  }

  try {
    await client.connect();
    console.log('Cursor IDE daemon running. Press Ctrl+C to stop.\n');
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}
