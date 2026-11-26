import { configFor } from '../context';

export function stop(options: { instance?: string } = {}): void {
  const config = configFor(options.instance);
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
