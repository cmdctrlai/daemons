import * as os from 'os';
import { ConfigManager, registerDevice } from '@cmdctrl/daemon-sdk';

const configManager = new ConfigManager('cursor-cli');

interface RegisterOptions {
  server: string;
  name?: string;
}

export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, '');
  const deviceName = options.name || `${os.hostname()}-cursor`;

  if (configManager.isRegistered()) {
    const config = configManager.readConfig();
    console.log(`Already registered as "${config?.deviceName}" (${config?.deviceId})`);
    console.log(`Server: ${config?.serverUrl}`);
    console.log(`\nTo re-register, run: cmdctrl-cursor-cli unregister`);
    return;
  }

  console.log(`Registering Cursor CLI device "${deviceName}" with ${serverUrl}...\n`);

  const result = await registerDevice(
    serverUrl,
    deviceName,
    os.hostname(),
    'cursor_cli',
    (url, _userCode) => {
      console.log('To complete registration, open this URL in your browser:\n');
      console.log(`  ${url}\n`);
      console.log('Waiting for verification...');
    }
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
  console.log(`\nRun 'cmdctrl-cursor-cli start' to connect to the server.`);
}
