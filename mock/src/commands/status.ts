import {
  readConfig,
  readCredentials,
  isRegistered,
  isDaemonRunning,
  readPidFile
} from '../config/config';

/**
 * Status command
 */
export function status(): void {
  if (!isRegistered()) {
    console.log('Status: Not registered');
    console.log('\nRun "cmdctrl-mock register" to register this device.');
    return;
  }

  const config = readConfig()!;
  const credentials = readCredentials();

  console.log('Mock Daemon Status');
  console.log('==================');
  console.log(`Device Name: ${config.deviceName}`);
  console.log(`Device ID: ${config.deviceId}`);
  console.log(`Server: ${config.serverUrl}`);

  if (credentials) {
    const now = Date.now();
    const expiresIn = credentials.expiresAt - now;
    if (expiresIn > 0) {
      const hours = Math.floor(expiresIn / 3600000);
      const minutes = Math.floor((expiresIn % 3600000) / 60000);
      console.log(`Token: Valid (expires in ${hours}h ${minutes}m)`);
    } else {
      console.log('Token: Expired');
    }
  } else {
    console.log('Token: Missing');
  }

  if (isDaemonRunning()) {
    const pid = readPidFile();
    console.log(`Daemon: Running (PID ${pid})`);
  } else {
    console.log('Daemon: Not running');
  }
}
