import {
  isDaemonRunning,
  readPidFile,
  deletePidFile
} from '../config/config';

/**
 * Stop command
 */
export function stop(): void {
  if (!isDaemonRunning()) {
    console.log('Daemon is not running.');
    return;
  }

  const pid = readPidFile();
  if (pid === null) {
    console.log('No PID file found.');
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    console.log(`Sent SIGTERM to daemon (PID ${pid})`);

    // Wait a bit and check if it stopped
    setTimeout(() => {
      try {
        process.kill(pid, 0);
        console.log('Daemon still running, sending SIGKILL...');
        process.kill(pid, 'SIGKILL');
      } catch {
        // Process is gone
      }
      deletePidFile();
      console.log('Daemon stopped.');
    }, 2000);
  } catch (err) {
    console.error('Failed to stop daemon:', err);
    deletePidFile();
  }
}
