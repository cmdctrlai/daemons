/**
 * Unregister command - remove this device from the CmdCtrl server.
 *
 * Calls the SDK's `unregisterDevice()` helper (DELETE /api/devices/{id})
 * and then clears the local config and credentials.
 */

import { unregisterDevice } from '@cmdctrl/daemon-sdk';
import { config } from '../context';

export async function unregister(): Promise<void> {
  if (!config.isRegistered()) {
    console.log('Not registered. Nothing to do.');
    return;
  }

  if (config.isDaemonRunning()) {
    console.error('Daemon is running. Run `cmdctrl-example stop` first.');
    process.exit(1);
  }

  const cfg = config.readConfig()!;
  const creds = config.readCredentials()!;

  console.log(`Unregistering "${cfg.deviceName}" (${cfg.deviceId}) from ${cfg.serverUrl}...`);

  const ok = await unregisterDevice(cfg.serverUrl, cfg.deviceId, creds.refreshToken);
  if (!ok) {
    console.error('Server did not accept the unregister request.');
    console.error('Local config will be kept so you can retry.');
    process.exit(1);
  }

  config.clearRegistration();
  console.log('Unregistered. Local config cleared.');
}
