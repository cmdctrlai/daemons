import * as readline from 'readline';
import { readConfig, readCredentials, clearRegistration, isDaemonRunning } from '../config/config';
import { stop } from './stop';

function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Unregister command - deletes device from server and removes local registration data
 */
export async function unregister(): Promise<void> {
  const config = readConfig();

  if (!config) {
    console.log('Not registered.');
    return;
  }

  // If daemon is running, offer to stop it first
  if (isDaemonRunning()) {
    const ok = await confirm('Daemon is currently running. Stop it before unregistering?');
    if (!ok) {
      console.log('Aborted.');
      return;
    }
    await stop();
  }

  console.log(`Unregistering device "${config.deviceName}" (${config.deviceId})...`);
  console.log(`Server: ${config.serverUrl}`);

  // Delete device from server
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
        console.warn('The device entry may still exist on the server.');
      }
    } catch (err) {
      console.warn(`Warning: Could not reach server to remove device.`);
      console.warn('The device entry may still exist on the server.');
    }
  }

  // Clear local registration data
  clearRegistration();

  console.log('Local registration data cleared.');
  console.log('You can now register again with: cmdctrl-claude-code register -s <server-url>');
}
