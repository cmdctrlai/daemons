/**
 * Register command - device authorization flow.
 *
 * Uses the SDK's `registerDevice()` helper, which implements the full
 * device authorization flow (similar to GitHub CLI):
 *   1. Request a verification code from the server
 *   2. User opens URL in browser and enters the code
 *   3. SDK polls for the token
 *   4. Store config and credentials locally via ConfigManager
 */

import * as os from 'os';
import { registerDevice } from '@cmdctrl/daemon-sdk';
import { AGENT_TYPE, config } from '../context';

interface RegisterOptions {
  server: string;
  name?: string;
}

export async function register(options: RegisterOptions): Promise<void> {
  const serverUrl = options.server.replace(/\/$/, '');
  const deviceName = options.name || os.hostname();

  if (config.isRegistered()) {
    const existing = config.readConfig();
    console.log(`Already registered as "${existing?.deviceName}" (${existing?.deviceId})`);
    console.log(`Server: ${existing?.serverUrl}`);
    return;
  }

  console.log(`Registering "${deviceName}" with ${serverUrl}...\n`);

  let result;
  try {
    result = await registerDevice(
      serverUrl,
      deviceName,
      os.hostname(),
      AGENT_TYPE,
      (verificationUrl) => {
        console.log('Open this URL in your browser to complete registration:\n');
        console.log(`  ${verificationUrl}\n`);
        console.log('Waiting for verification...');
      }
    );
  } catch (err) {
    console.error('\nRegistration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }

  if (!result) {
    console.error('\nVerification code expired. Please try again.');
    process.exit(1);
  }

  config.writeConfig({
    serverUrl,
    deviceId: result.deviceId,
    deviceName,
  });
  config.writeCredentials({ refreshToken: result.refreshToken });

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${result.deviceId}`);
  console.log(`\nRun 'cmdctrl-pi start' to connect.`);
}
