import {
  readConfig,
  readCredentials,
  isRegistered,
  isDaemonRunning,
  readPidFile
} from '../config/config';

/**
 * Status command - check daemon and connection status
 */
export async function status(): Promise<void> {
  console.log('CmdCtrl Aider Daemon Status\n');

  // Registration status
  if (!isRegistered()) {
    console.log('Registration: Not registered');
    console.log('\nRun "cmdctrl-aider register" to register this device.');
    return;
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log('Registration: Registered');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName}`);
  console.log(`  Device ID: ${config.deviceId}`);

  // Token status
  const tokenExpired = credentials.expiresAt < Date.now();
  console.log(`\nToken: ${tokenExpired ? 'Expired' : 'Valid'}`);
  if (!tokenExpired) {
    const expiresIn = Math.round((credentials.expiresAt - Date.now()) / 1000 / 60);
    console.log(`  Expires in: ${expiresIn} minutes`);
  }

  // Daemon status
  const running = isDaemonRunning();
  console.log(`\nDaemon: ${running ? 'Running' : 'Stopped'}`);
  if (running) {
    const pid = readPidFile();
    console.log(`  PID: ${pid}`);
  }
}
