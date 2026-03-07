import { readConfig, readCredentials, clearRegistration, isDaemonRunning } from '../config/config';

export async function unregister(): Promise<void> {
  const config = readConfig();

  if (!config) {
    console.log('Not registered.');
    return;
  }

  if (isDaemonRunning()) {
    console.error('Error: Daemon is currently running.');
    console.error('Please stop the daemon first with: cmdctrl-copilot-cli stop');
    process.exit(1);
  }

  console.log(`Unregistering device "${config.deviceName}" (${config.deviceId})...`);

  const credentials = readCredentials();
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

  clearRegistration();
  console.log('Local registration data cleared.');
  console.log('You can now register again with: cmdctrl-copilot-cli register -s <server-url>');
}
