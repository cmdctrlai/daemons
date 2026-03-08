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

export async function unregister(): Promise<void> {
  const config = readConfig();

  if (!config) {
    console.log('Not registered.');
    return;
  }

  if (isDaemonRunning()) {
    const ok = await confirm('Daemon is currently running. Stop it before unregistering?');
    if (!ok) {
      console.log('Aborted.');
      return;
    }
    await stop();
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
  console.log('You can now register again with: cmdctrl-codex-cli register -s <server-url>');
}
