import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  isDaemonRunning
} from '../config/config';
import { DaemonClient } from '../client/websocket';

interface StartOptions {
  foreground?: boolean;
}

/**
 * Start command - launch the daemon and connect to server
 */
export async function start(options: StartOptions): Promise<void> {
  // Check registration
  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-claude-code-daemon register" first.');
    process.exit(1);
  }

  // Check if already running
  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-claude-code-daemon stop" first.');
    process.exit(1);
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log(`Starting CmdCtrl daemon...`);
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Device: ${config.deviceName} (${config.deviceId})`);

  // Write PID file
  writePidFile(process.pid);

  // Create and start client
  const client = new DaemonClient(config, credentials);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (options.foreground) {
    console.log('Running in foreground. Press Ctrl+C to stop.\n');
  }

  // Connect and run - initial failure is handled by the reconnect loop,
  // so we never exit here. The process must stay alive for retry timers to fire.
  client.connect().catch(() => {
    console.warn('Initial connection failed, will retry...');
  });

  // Keep process alive - the WebSocket client handles events and reconnects
  await new Promise(() => {
    // Never resolves - daemon runs until killed
  });
}
