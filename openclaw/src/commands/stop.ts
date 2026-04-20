import { ConfigManager } from '@cmdctrl/daemon-sdk';

const configManager = new ConfigManager('openclaw');

export function stop(): void {
  if (!configManager.isDaemonRunning()) {
    console.log('Daemon is not running.');
    return;
  }

  const pid = configManager.readPidFile();
  if (pid === null) {
    console.log('No PID file found.');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);

    setTimeout(() => {
      try {
        process.kill(pid, 0);
        console.log('Daemon still running, sending SIGKILL...');
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process is gone
      }
      configManager.deletePidFile();
      console.log('Daemon stopped.');
    }, 2000);
  } catch (err) {
    console.error('Failed to stop daemon:', err);
    configManager.deletePidFile();
  }
}
