import { ConfigManager } from '@cmdctrl/daemon-sdk';

const configManager = new ConfigManager('opencode');

export async function unregister(): Promise<void> {
  const config = configManager.readConfig();

  if (!config) {
    console.log('Not registered.');
    return;
  }

  if (configManager.isDaemonRunning()) {
    console.error('Error: Daemon is currently running.');
    console.error('Please stop the daemon first with: cmdctrl-opencode stop');
    process.exit(1);
  }

  console.log(`Unregistering device "${config.deviceName}" (${config.deviceId})...`);

  const credentials = configManager.readCredentials();
  if (credentials) {
    try {
      const response = await fetch(`${config.serverUrl}/api/devices/${config.deviceId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${credentials.refreshToken}` },
      });
      if (response.ok || response.status === 204) {
        console.log('Device removed from server.');
      } else if (response.status === 404) {
        console.log('Device was already removed from server.');
      } else {
        console.warn(`Warning: Failed to remove device from server (HTTP ${response.status}).`);
      }
    } catch {
      console.warn('Warning: Could not reach server to remove device.');
    }
  }

  configManager.clearRegistration();
  console.log('Local registration data cleared.');
  console.log('You can now register again with: cmdctrl-opencode register -s <server-url>');
}
