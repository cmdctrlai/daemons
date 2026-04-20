import * as os from 'os';
import * as readline from 'readline';
import { openSync } from 'fs';
import { spawn } from 'child_process';
import { ConfigManager, registerDevice } from '@cmdctrl/daemon-sdk';
import { stop } from './stop';

const configManager = new ConfigManager('openclaw');

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

export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, '');
  const deviceName = options.name || `${os.hostname()}-openclaw`;

  if (configManager.isRegistered()) {
    const existing = configManager.readConfig();
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

    if (configManager.isDaemonRunning()) {
      await stop();
    }

    const credentials = configManager.readCredentials();
    if (existing && credentials) {
      try {
        const response = await fetch(`${existing.serverUrl}/api/devices/${existing.deviceId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${credentials.refreshToken}` },
        });
        if (response.ok || response.status === 204 || response.status === 404) {
          console.log('Previous device registration removed from server.');
        } else {
          console.warn(`Warning: Failed to remove old device from server (HTTP ${response.status}).`);
        }
      } catch {
        console.warn('Warning: Could not reach server to remove old device.');
      }
    }

    configManager.clearRegistration();
    console.log('');
  }

  console.log(`Registering OpenClaw device "${deviceName}" with ${serverUrl}...\n`);

  const result = await registerDevice(
    serverUrl,
    deviceName,
    os.hostname(),
    'openclaw',
    (url) => {
      console.log('To complete registration, open this URL in your browser:\n');
      console.log(`  ${url}\n`);
      console.log('Waiting for verification...');
    },
  );

  if (!result) {
    console.error('\nDevice code expired. Please try again.');
    process.exit(1);
  }

  configManager.writeConfig({
    serverUrl,
    deviceId: result.deviceId,
    deviceName,
  });

  configManager.writeCredentials({
    refreshToken: result.refreshToken,
    accessToken: result.accessToken,
    expiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : undefined,
  });

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${result.deviceId}`);

  if (process.stdin.isTTY) {
    const startNow = await confirm('\nStart daemon in background now?');
    if (startNow) {
      const logFile = '/tmp/cmdctrl-daemon-openclaw.log';
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
