import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import * as readline from 'readline';
import { openSync } from 'fs';
import { spawn } from 'child_process';
import { URL } from 'url';
import {
  writeConfig,
  writeCredentials,
  readConfig,
  readCredentials,
  deleteConfig,
  deleteCredentials,
  isRegistered,
  isDaemonRunning,
  CmdCtrlConfig,
  Credentials,
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

interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
}

/**
 * Make an HTTP(S) request
 */
function request(
  url: string,
  method: string,
  body?: object
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    };

    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode || 0, data: parsed });
        } catch {
          resolve({ status: res.statusCode || 0, data: {} });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

/**
 * Poll for token completion (after user verifies in browser)
 */
async function pollForToken(
  serverUrl: string,
  deviceCode: string,
  interval: number,
  expiresIn: number
): Promise<TokenResponse | null> {
  const startTime = Date.now();
  const expiresAt = startTime + expiresIn * 1000;

  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    try {
      const response = await request(`${serverUrl}/api/devices/token`, 'POST', {
        deviceCode,
      });

      if (response.status === 200) {
        return response.data as TokenResponse;
      }

      const data = response.data as { error?: string };
      if (response.status === 400 && data.error === 'authorization_pending') {
        process.stdout.write('.');
        continue;
      }

      if (response.status >= 400) {
        console.error('\nError polling for token:', data);
        return null;
      }
    } catch (err) {
      console.error('\nError polling for token:', err);
      return null;
    }
  }

  console.error('\nDevice code expired. Please try again.');
  return null;
}

/**
 * Register command - implements GitHub CLI style device auth flow
 */
export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, '');
  const deviceName = options.name || `${os.hostname()}-copilot`;

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

    const credentials = readCredentials();
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

    deleteCredentials();
    deleteConfig();
    console.log('');
  }

  console.log(`Registering device "${deviceName}" with ${serverUrl}...\n`);

  // Step 1: Request device code
  let codeResponse: DeviceCodeResponse;
  try {
    const response = await request(`${serverUrl}/api/devices/code`, 'POST', {
      deviceName,
      hostname: os.hostname(),
      agentType: 'vscode_copilot', // Identify as VS Code Copilot daemon
    });

    if (response.status !== 200) {
      console.error('Failed to get device code:', response.data);
      process.exit(1);
    }

    codeResponse = response.data as DeviceCodeResponse;
  } catch (err) {
    console.error('Failed to connect to server:', err);
    process.exit(1);
  }

  // Step 2: Display instructions to user
  console.log('To complete registration, open this URL in your browser:\n');
  console.log(`  ${codeResponse.verificationUrl}\n`);
  console.log('Waiting for verification...');

  // Step 3: Poll for completion
  const tokenResponse = await pollForToken(
    serverUrl,
    codeResponse.deviceCode,
    codeResponse.interval,
    codeResponse.expiresIn
  );

  if (!tokenResponse) {
    process.exit(1);
  }

  // Step 4: Save config and credentials
  const config: CmdCtrlConfig = {
    serverUrl,
    deviceId: tokenResponse.deviceId,
    deviceName,
  };

  const credentials: Credentials = {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    expiresAt: Date.now() + tokenResponse.expiresIn * 1000,
  };

  writeConfig(config);
  writeCredentials(credentials);

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${tokenResponse.deviceId}`);

  if (process.stdin.isTTY) {
    const startNow = await confirm('\nStart daemon in background now?');
    if (startNow) {
      const logFile = '/tmp/cmdctrl-daemon-vscode-copilot.log';
      const logFd = openSync(logFile, 'a');
      const child = spawn(process.execPath, [process.argv[1], 'start'], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      console.log(`Daemon started. Logs: tail -f ${logFile}`);
    }
  }

  console.log(`\nIMPORTANT: Make sure to start VS Code with:`);
  console.log(`  code --remote-debugging-port=9223`);
}
