import * as readline from 'readline';
import { readConfig, readCredentials, deleteConfig, deleteCredentials, isRegistered, isDaemonRunning } from '../config/config';
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
  if (!isRegistered()) {
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

  const config = readConfig();
  console.log(`Unregistering "${config?.deviceName}" (${config?.deviceId})...`);

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

  console.log('Device unregistered. Run "cmdctrl-vscode-copilot register" to register again.');
}
