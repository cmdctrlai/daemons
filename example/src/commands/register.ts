/**
 * Register command - device authorization flow.
 *
 * Works like GitHub CLI device auth:
 * 1. Request a verification code from the server
 * 2. User opens URL in browser and enters the code
 * 3. Daemon polls for the token
 * 4. Store config and credentials locally
 */

import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import { writeConfig, writeCredentials, readConfig, isRegistered, Config, Credentials } from '../config';

interface RegisterOptions {
  server: string;
  name?: string;
}

function httpRequest(url: string, method: string, body?: object): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode || 0, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode || 0, data: {} });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function pollForToken(
  serverUrl: string,
  deviceCode: string,
  interval: number,
  expiresIn: number
): Promise<{ deviceId: string; refreshToken: string } | null> {
  const expiresAt = Date.now() + expiresIn * 1000;

  while (Date.now() < expiresAt) {
    await new Promise(resolve => setTimeout(resolve, interval * 1000));

    try {
      const res = await httpRequest(`${serverUrl}/api/devices/token`, 'POST', { deviceCode });
      if (res.status === 200) {
        return { deviceId: res.data.deviceId, refreshToken: res.data.refreshToken };
      }
      if (res.status === 400 && res.data.error === 'authorization_pending') {
        process.stdout.write('.');
        continue;
      }
      console.error('\nError:', res.data);
      return null;
    } catch (err) {
      console.error('\nError polling:', err);
      return null;
    }
  }

  console.error('\nVerification code expired. Please try again.');
  return null;
}

export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, '');
  const deviceName = options.name || os.hostname();

  if (isRegistered()) {
    const config = readConfig();
    console.log(`Already registered as "${config?.deviceName}" (${config?.deviceId})`);
    console.log(`Server: ${config?.serverUrl}`);
    return;
  }

  console.log(`Registering "${deviceName}" with ${serverUrl}...\n`);

  let codeRes;
  try {
    const res = await httpRequest(`${serverUrl}/api/devices/code`, 'POST', {
      deviceName,
      hostname: os.hostname(),
      agentType: 'example',  // Change this to your agent type
    });
    if (res.status !== 200) {
      console.error('Failed to get device code:', res.data);
      process.exit(1);
    }
    codeRes = res.data;
  } catch (err) {
    console.error('Failed to connect to server:', err);
    process.exit(1);
  }

  console.log('Open this URL in your browser to complete registration:\n');
  console.log(`  ${codeRes.verificationUrl}\n`);
  console.log('Waiting for verification...');

  const token = await pollForToken(serverUrl, codeRes.deviceCode, codeRes.interval, codeRes.expiresIn);
  if (!token) process.exit(1);

  writeConfig({ serverUrl, deviceId: token.deviceId, deviceName });
  writeCredentials({ refreshToken: token.refreshToken });

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${token.deviceId}`);
  console.log(`\nRun 'cmdctrl-example start' to connect.`);
}
