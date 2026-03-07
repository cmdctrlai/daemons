/**
 * Stop command - stop the running daemon.
 */

import { readPidFile, deletePidFile, isDaemonRunning } from '../config';

export function stop(): void {
  if (!isDaemonRunning()) {
    console.log('Daemon is not running.');
    return;
  }

  const pid = readPidFile();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped daemon (PID ${pid})`);
    } catch {
      console.log('Daemon process not found, cleaning up PID file.');
    }
    deletePidFile();
  }
}
