/**
 * Status command - show registration and daemon status.
 */

import { config } from '../context';

export function status(): void {
  if (!config.isRegistered()) {
    console.log('Status: Not registered');
    console.log('Run: cmdctrl-pi register -s <server-url>');
    return;
  }

  const cfg = config.readConfig()!;
  const running = config.isDaemonRunning();
  const pid = config.readPidFile();

  console.log(`Device:  ${cfg.deviceName} (${cfg.deviceId})`);
  console.log(`Server:  ${cfg.serverUrl}`);
  console.log(`Daemon:  ${running ? `Running (PID ${pid})` : 'Stopped'}`);
}
