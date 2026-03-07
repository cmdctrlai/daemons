import { readConfig, readCredentials, deleteConfig, deleteCredentials, isRegistered } from '../config/config';

/**
 * Unregister command - deletes device from server and removes local registration data
 */
export async function unregister(): Promise<void> {
  if (!isRegistered()) {
    console.log('Not registered.');
    return;
  }

  const config = readConfig();
  console.log(`Unregistering "${config?.deviceName}" (${config?.deviceId})...`);

  // Delete device from server
  if (config) {
    const credentials = readCredentials();
    if (credentials) {
      try {
        const response = await fetch(`${config.serverUrl}/api/devices/${config.deviceId}`, {
          method: 'DELETE',
          headers: {
            'Authorization': `Bearer ${credentials.refreshToken}`,
          },
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
  }

  deleteCredentials();
  deleteConfig();

  console.log('Device unregistered. Run "cmdctrl-cursor-ide register" to register again.');
}
