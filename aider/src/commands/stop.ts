import { isDaemonRunning, readPidFile, deletePidFile } from '../config/config';

/**
 * Stop command - stop the running daemon
 */
export async function stop(): Promise<void> {
  if (!isDaemonRunning()) {
    console.log('Daemon is not running.');
    return;
  }

  const pid = readPidFile();
  if (pid === null) {
    console.log('No PID file found.');
    return;
  }

  console.log(`Stopping daemon (PID ${pid})...`);

  try {
    // Send SIGTERM for graceful shutdown
    process.kill(pid, 'SIGTERM');

    // Wait for process to exit (up to 5 seconds)
    let attempts = 0;
    while (attempts < 50) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try {
        process.kill(pid, 0); // Check if still running
        attempts++;
      } catch {
        // Process has exited
        break;
      }
    }

    // If still running after 5 seconds, force kill
    try {
      process.kill(pid, 0);
      console.log('Daemon did not stop gracefully, sending SIGKILL...');
      process.kill(pid, 'SIGKILL');
    } catch {
      // Already dead, good
    }

    deletePidFile();
    console.log('Daemon stopped.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') {
      // Process doesn't exist
      deletePidFile();
      console.log('Daemon was not running (stale PID file removed).');
    } else {
      console.error('Failed to stop daemon:', err);
      process.exit(1);
    }
  }
}
