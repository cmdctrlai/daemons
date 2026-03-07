import {
  readConfig,
  readCredentials,
  isRegistered,
  writePidFile,
  isDaemonRunning,
} from '../config/config';
import { DaemonClient } from '../client/websocket';

interface StartOptions {
  foreground?: boolean;
}

export async function start(_options: StartOptions): Promise<void> {
  if (!isRegistered()) {
    console.error('Device not registered. Run "cmdctrl-gemini-cli register" first.');
    process.exit(1);
  }

  if (isDaemonRunning()) {
    console.error('Daemon is already running. Run "cmdctrl-gemini-cli stop" first.');
    process.exit(1);
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log('Gemini CLI Daemon');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName} (${config.deviceId})`);
  console.log('');

  writePidFile(process.pid);

  const client = new DaemonClient(config, credentials);

  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
    console.log('Gemini CLI daemon running. Press Ctrl+C to stop.\n');
    await new Promise(() => {});
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}
