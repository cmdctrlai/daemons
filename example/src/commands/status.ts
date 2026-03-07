/**
 * Status command - show registration and daemon status.
 */

import { readConfig, isRegistered, isDaemonRunning, readPidFile } from '../config';

export function status(): void {
  if (!isRegistered()) {
    console.log('Status: Not registered');
    console.log('Run: cmdctrl-example register -s <server-url>');
    return;
  }

  const config = readConfig()!;
  const running = isDaemonRunning();
  const pid = readPidFile();

  console.log(`Device:  ${config.deviceName} (${config.deviceId})`);
  console.log(`Server:  ${config.serverUrl}`);
  console.log(`Daemon:  ${running ? `Running (PID ${pid})` : 'Stopped'}`);
}
