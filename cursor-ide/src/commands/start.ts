import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  isDaemonRunning,
  cursorDbExists,
} from '../config/config';
import { DaemonClient } from '../client/websocket';
import { getCDPClient } from '../adapter/cdp-client';

interface StartOptions {
  foreground?: boolean;
}

/**
 * Start command - launch the daemon and connect to server
 */
export async function start(options: StartOptions): Promise<void> {
  // Set up global error handlers to catch silent crashes
  process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught exception:', err);
    process.exit(1);
  });

  process.on('unhandledRejection', (reason, promise) => {
    console.error('[FATAL] Unhandled promise rejection:', reason);
    console.error('Promise:', promise);
    process.exit(1);
  });

  // Check registration
  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-cursor-ide register" first.');
    process.exit(1);
  }

  // Check if already running
  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-cursor-ide stop" first.');
    process.exit(1);
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log(`Starting CmdCtrl Cursor IDE daemon...`);
  console.log(`Server: ${config.serverUrl}`);
  console.log(`Device: ${config.deviceName} (${config.deviceId})`);

  // Check if Cursor database exists
  if (!cursorDbExists()) {
    console.warn('\nWarning: Cursor database not found.');
    console.warn('Make sure Cursor has been run at least once.');
  }

  // Check CDP availability
  const cdp = getCDPClient();
  const cdpAvailable = await cdp.isAvailable();
  if (!cdpAvailable) {
    console.warn('\nWarning: Cursor CDP not available.');
    console.warn('To enable message injection, start Cursor with:');
    console.warn('  /Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222');
    console.warn('\nContinuing with observation-only mode...');
  } else {
    console.log('\nCDP: Connected to Cursor');
    const title = await cdp.getWindowTitle();
    if (title) {
      console.log(`  Active project: ${title}`);
    }
  }

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

  // Connect and run
  try {
    await client.connect();
    console.log('Connected to CmdCtrl server.');

    if (options.foreground) {
      console.log('Running in foreground. Press Ctrl+C to stop.\n');
    }

    // Keep process alive
    await new Promise(() => {
      // Never resolves - daemon runs until killed
    });
  } catch (err) {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  }
}
