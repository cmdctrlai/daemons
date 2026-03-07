import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import {
  writeConfig,
  writeCredentials,
  readConfig,
  isRegistered,
  CmdCtrlConfig,
  Credentials
} from '../config/config';

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
        Accept: 'application/json'
      }
    };
    const req = client.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
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
): Promise<TokenResponse | null> {
  const expiresAt = Date.now() + expiresIn * 1000;
  while (Date.now() < expiresAt) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
    try {
      const response = await request(`${serverUrl}/api/devices/token`, 'POST', { deviceCode });
      if (response.status === 200) return response.data as TokenResponse;
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

export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, '');
  const deviceName = options.name || `${os.hostname()}-copilot`;

  if (isRegistered()) {
    const config = readConfig();
    console.log(`Already registered as "${config?.deviceName}" (${config?.deviceId})`);
    console.log(`Server: ${config?.serverUrl}`);
    console.log(`\nTo re-register, run: cmdctrl-copilot-cli unregister`);
    return;
  }

  console.log(`Registering Copilot CLI device "${deviceName}" with ${serverUrl}...\n`);

  let codeResponse: DeviceCodeResponse;
  try {
    const response = await request(`${serverUrl}/api/devices/code`, 'POST', {
      deviceName,
      hostname: os.hostname(),
      agentType: 'copilot_cli',
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

  console.log('To complete registration, open this URL in your browser:\n');
  console.log(`  ${codeResponse.verificationUrl}\n`);
  console.log('Waiting for verification...');

  const tokenResponse = await pollForToken(
    serverUrl,
    codeResponse.deviceCode,
    codeResponse.interval,
    codeResponse.expiresIn
  );

  if (!tokenResponse) process.exit(1);

  const config: CmdCtrlConfig = {
    serverUrl,
    deviceId: tokenResponse.deviceId,
    deviceName
  };

  const credentials: Credentials = {
    accessToken: tokenResponse.accessToken,
    refreshToken: tokenResponse.refreshToken,
    expiresAt: Date.now() + tokenResponse.expiresIn * 1000
  };

  writeConfig(config);
  writeCredentials(credentials);

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${tokenResponse.deviceId}`);
  console.log(`\nRun 'cmdctrl-copilot-cli start' to connect to the server.`);
}
