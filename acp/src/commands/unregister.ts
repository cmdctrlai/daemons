import { unregisterDevice } from '@cmdctrl/daemon-sdk';
import { commandFor, configFor } from '../context';

export async function unregister(options: { instance?: string } = {}): Promise<void> {
  const config = configFor(options.instance);
  if (!config.isRegistered()) {
    console.log('Not registered. Nothing to do.');
    return;
  }
  if (config.isDaemonRunning()) {
    console.error(`Daemon is running. Run \`${commandFor('stop', options.instance)}\` first.`);
    process.exit(1);
  }

  const cfg = config.readConfig()!;
  const creds = config.readCredentials()!;
  console.log(`Unregistering "${cfg.deviceName}" (${cfg.deviceId}) from ${cfg.serverUrl}...`);

  if (!(await unregisterDevice(cfg.serverUrl, cfg.deviceId, creds.refreshToken))) {
    console.error('Server did not accept the unregister request.');
    console.error('Local config will be kept so you can retry.');
    process.exit(1);
  }
  config.clearRegistration();
  console.log('Unregistered. Local config cleared.');
}
