import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  isDaemonRunning,
  spawnDetached
} from '../config/config';
import { createDaemon } from '../client/daemon';

interface StartOptions {
  foreground?: boolean;
  detach?: boolean;
}

/**
 * Start command - launch the daemon and connect to server
 */
export async function start(options: StartOptions): Promise<void> {
  // Check registration
  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-claude-code register" first.');
    process.exit(1);
  }

  // Check if already running
  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-claude-code stop" first.');
    process.exit(1);
  }

  if (options.detach) {
    const { pid, logFile } = spawnDetached();
    console.log(`Daemon started in background (pid ${pid}).`);
    console.log(`Logs: ${logFile}`);
    return;
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log(`Starting CmdCtrl daemon...`);
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Device: ${config.deviceName} (${config.deviceId})`);

  // Write PID file
  writePidFile(process.pid);

  const daemon = createDaemon(config, credentials);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await daemon.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (options.foreground) {
    console.log('Running in foreground. Press Ctrl+C to stop.\n');
  }

  // Connect and run - initial failure is handled by the reconnect loop,
  // so we never exit here. The process must stay alive for retry timers to fire.
  daemon.client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  // Keep process alive - the WebSocket client handles events and reconnects
  await new Promise(() => {
    // Never resolves - daemon runs until killed
  });
}
