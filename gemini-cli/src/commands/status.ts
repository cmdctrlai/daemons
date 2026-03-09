import { ConfigManager } from '@cmdctrl/daemon-sdk';

const configManager = new ConfigManager('gemini-cli');

export function status(): void {
  if (!configManager.isRegistered()) {
    console.log('Status: Not registered');
    console.log('\nRun "cmdctrl-gemini-cli register" to register this device.');
    return;
  }

  const config = configManager.readConfig()!;
  const credentials = configManager.readCredentials();

  console.log('Gemini CLI Daemon Status');
  console.log('========================');
  console.log(`Device Name: ${config.deviceName}`);
  console.log(`Device ID:   ${config.deviceId}`);
  console.log(`Server:      ${config.serverUrl}`);

  if (credentials?.expiresAt) {
    const expiresIn = credentials.expiresAt - Date.now();
    if (expiresIn > 0) {
      const hours = Math.floor(expiresIn / 3600000);
      const minutes = Math.floor((expiresIn % 3600000) / 60000);
      console.log(`Token:       Valid (expires in ${hours}h ${minutes}m)`);
    } else {
      console.log('Token:       Expired');
    }
  } else {
    console.log('Token:       Present');
  }

  if (configManager.isDaemonRunning()) {
    const pid = configManager.readPidFile();
    console.log(`Daemon:      Running (PID ${pid})`);
  } else {
    console.log('Daemon:      Not running');
    console.log('\nRun "cmdctrl-gemini-cli start" to start the daemon.');
  }
}
