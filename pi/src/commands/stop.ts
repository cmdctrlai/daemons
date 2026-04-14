/**
 * Stop command - stop the running daemon.
 */

import { config } from '../context';

export function stop(): void {
  if (!config.isDaemonRunning()) {
    console.log('Daemon is not running.');
    return;
  }

  const pid = config.readPidFile();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Stopped daemon (PID ${pid})`);
    } catch {
      console.log('Daemon process not found, cleaning up PID file.');
    }
    config.deletePidFile();
  }
}
