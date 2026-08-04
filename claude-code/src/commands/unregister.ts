import * as readline from 'readline';
import { unregisterDevice } from '@cmdctrl/daemon-sdk';
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
    const removed = await unregisterDevice(config.serverUrl, config.deviceId, credentials.refreshToken);
    if (removed) {
      console.log('Device removed from server.');
    } else {
      console.warn('Warning: Failed to remove device from server.');
      console.warn('The device entry may still exist on the server.');
    }
  }

  // Clear local registration data
  clearRegistration();

  console.log('Local registration data cleared.');
  console.log('You can now register again with: cmdctrl-claude-code register -s <server-url>');
}
