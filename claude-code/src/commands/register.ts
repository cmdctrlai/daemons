import * as os from 'os';
import * as readline from 'readline';
import { openSync } from 'fs';
import { spawn } from 'child_process';
import { registerDevice, unregisterDevice } from '@cmdctrl/daemon-sdk';
import {
  writeConfig,
  writeCredentials,
  readConfig,
  readCredentials,
  clearRegistration,
  isRegistered,
  isDaemonRunning,
} from '../config/config';
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

interface RegisterOptions {
  server: string;
  name?: string;
}

/**
 * Register command - implements GitHub CLI style device auth flow
 */
export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, ''); // Remove trailing slash
  const deviceName = options.name || os.hostname();

  // Check if already registered
  if (isRegistered()) {
    const existing = readConfig();
    console.log(`Already registered as "${existing?.deviceName}" (${existing?.deviceId})`);
    console.log(`Server: ${existing?.serverUrl}`);

    if (!process.stdin.isTTY) {
      console.error('\nAlready registered. Unregister first or run interactively to re-register.');
      process.exit(1);
    }

    const ok = await confirm('\nStop and re-register this device?');
    if (!ok) {
      console.log('Aborted.');
      return;
    }

    if (isDaemonRunning()) {
      await stop();
    }

    // Delete device from server before clearing local data
    const credentials = readCredentials();
    if (existing && credentials) {
      const removed = await unregisterDevice(existing.serverUrl, existing.deviceId, credentials.refreshToken);
      console.log(removed
        ? 'Previous device registration removed from server.'
        : 'Warning: Failed to remove old device from server.');
    }

    clearRegistration();
    console.log('');
  }

  console.log(`Registering device "${deviceName}" with ${serverUrl}...\n`);

  const result = await registerDevice(serverUrl, deviceName, os.hostname(), 'claude_code', (url) => {
    console.log('To complete registration, open this URL in your browser:\n');
    console.log(`  ${url}\n`);
    console.log('Waiting for verification...');
  }).catch((err: Error) => {
    console.error(`\nRegistration failed: ${err.message}`);
    process.exit(1);
  });

  if (!result) {
    console.error('\nDevice code expired. Please try again.');
    process.exit(1);
  }

  writeConfig({ serverUrl, deviceId: result.deviceId, deviceName });
  writeCredentials({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
    expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
  });

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${result.deviceId}`);

  // Offer to start the daemon in the background (interactive only – scripts handle this themselves)
  if (process.stdin.isTTY) {
    const startNow = await confirm('\nStart daemon in background now?');
    if (startNow) {
      const logFile = '/tmp/cmdctrl-daemon-claude-code.log';
      const logFd = openSync(logFile, 'a');
      const child = spawn(process.execPath, [process.argv[1], 'start'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      console.log(`Daemon started. Logs: tail -f ${logFile}`);
    }
  }
}
