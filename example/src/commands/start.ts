/**
 * Start command - connect to the CmdCtrl server and listen for tasks.
 */

import { readConfig, readCredentials, isRegistered, writePidFile, isDaemonRunning } from '../config';
import { DaemonClient } from '../daemon-client';

export async function start(): Promise<void> {
  if (!isRegistered()) {
    console.error('Not registered. Run: cmdctrl-example register -s <server-url>');
    process.exit(1);
  }

  if (isDaemonRunning()) {
    console.error('Daemon is already running.');
    process.exit(1);
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log(`Starting daemon for device "${config.deviceName}"...`);
  console.log(`Server: ${config.serverUrl}`);

  writePidFile(process.pid);

  const client = new DaemonClient(config, credentials);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
    console.log('Daemon is running. Press Ctrl+C to stop.');
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}
