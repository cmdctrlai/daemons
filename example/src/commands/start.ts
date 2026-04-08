/**
 * Start command - connect to the CmdCtrl server and listen for tasks.
 *
 * This is the core of the daemon. It wires the user's agent logic
 * (`../agent.ts`) and message store (`../message-store.ts`) to the
 * SDK's DaemonClient, which handles all WebSocket protocol details
 * (connection, reconnection, heartbeat, message routing).
 */

import { randomUUID } from 'crypto';
import { DaemonClient } from '@cmdctrl/daemon-sdk';
import { AGENT_TYPE, DAEMON_VERSION, config } from '../context';
import { startTask, resumeTask, cancelTask, registerSession } from '../agent';
import { storeMessage, getMessages } from '../message-store';

export async function start(): Promise<void> {
  if (!config.isRegistered()) {
    console.error('Not registered. Run: cmdctrl-example register -s <server-url>');
    process.exit(1);
  }

  if (config.isDaemonRunning()) {
    console.error('Daemon is already running.');
    process.exit(1);
  }

  const cfg = config.readConfig()!;
  const creds = config.readCredentials()!;

  console.log(`Starting daemon for device "${cfg.deviceName}"...`);
  console.log(`Server: ${cfg.serverUrl}`);

  config.writePidFile(process.pid);

  // --- Construct the SDK client ---
  const client = new DaemonClient({
    serverUrl: cfg.serverUrl,
    deviceId: cfg.deviceId,
    agentType: AGENT_TYPE,
    token: creds.refreshToken,
    version: DAEMON_VERSION,
  });

  // --- Wire handlers to your agent logic ---

  // New task: a user has started a fresh session.
  client.onTaskStart(async (task) => {
    console.log(`Starting task: ${task.instruction.substring(0, 80)}`);

    // Allocate a native session ID and tell the server about it.
    // The SDK sends the SESSION_STARTED event for us.
    const sessionId = randomUUID();
    task.sessionStarted(sessionId);

    // Record the user's message in our local store.
    storeMessage(sessionId, 'USER', task.instruction);

    // Run the agent. Progress callbacks surface as status in the UI.
    const result = await startTask(
      task.instruction,
      task.projectPath,
      (action, target) => task.progress(action, target)
    );

    // Record the agent's reply and register the conversation.
    storeMessage(sessionId, 'AGENT', result);
    registerSession(sessionId, task.instruction, result);

    // Complete the task. Errors thrown from inside the handler are
    // automatically translated to ERROR events by the SDK.
    task.complete(result);
  });

  // Follow-up message on an existing session.
  client.onTaskResume(async (task) => {
    console.log(`Resuming session ${task.sessionId}: ${task.message.substring(0, 80)}`);

    storeMessage(task.sessionId, 'USER', task.message);

    const result = await resumeTask(
      task.sessionId,
      task.message,
      task.projectPath,
      (action, target) => task.progress(action, target)
    );

    storeMessage(task.sessionId, 'AGENT', result);
    task.complete(result);
  });

  // Cancellation: clean up any in-flight work for this task.
  client.onTaskCancel((taskId) => {
    console.log(`Cancelling task: ${taskId}`);
    // task_id is canonical: device:agent:native. Extract the native id.
    const parts = taskId.split(':');
    if (parts.length >= 3) {
      cancelTask(parts.slice(2).join(':'));
    }
  });

  // Message history: return whatever the server asks for from our store.
  client.onGetMessages((req) => {
    const result = getMessages(req.sessionId, req.limit, req.beforeUuid, req.afterUuid);
    return {
      messages: result.messages,
      hasMore: result.hasMore,
      oldestUuid: result.oldestUuid,
      newestUuid: result.newestUuid,
    };
  });

  // --- Graceful shutdown ---
  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    config.deletePidFile();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // --- Connect and stay alive ---
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
