import { commandFor, configFor, readAcpConfig } from '../context';

export function status(options: { instance?: string } = {}): void {
  const config = configFor(options.instance);
  const cfg = readAcpConfig(config);
  if (!config.isRegistered() || !cfg) {
    console.log('Status: Not registered');
    console.log(`Run: ${commandFor('register', options.instance)} --agent "<command>" -s <server-url>`);
    return;
  }
  const running = config.isDaemonRunning();
  console.log(`Device:  ${cfg.deviceName} (${cfg.deviceId})`);
  console.log(`Server:  ${cfg.serverUrl}`);
  console.log(`Agent:   ${cfg.agentCommand}`);
  console.log(`Daemon:  ${running ? `Running (PID ${config.readPidFile()})` : 'Stopped'}`);
}
