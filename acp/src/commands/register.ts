/**
 * Register – check the agent command speaks ACP, then run the device
 * authorization flow and store the command with the registration.
 */
import * as os from 'os';
import * as path from 'path';
import { registerDevice, displayVerification } from '@cmdctrl/daemon-sdk';
import { AcpAgent } from '../agent';
import { parseCommandLine } from '../command-line';
import { AGENT_TYPE, BIN_NAME, DAEMON_VERSION, commandFor, configFor, readAcpConfig, type AcpConfig } from '../context';

interface RegisterOptions {
  agent?: string;
  server: string;
  name?: string;
  instance?: string;
}

export async function register(options: RegisterOptions): Promise<void> {
  const config = configFor(options.instance);
  const existing = readAcpConfig(config);

  if (config.isRegistered() && existing) {
    if (options.agent && options.agent !== existing.agentCommand) {
      await probe(options.agent);
      const updated: AcpConfig = { ...existing, agentCommand: options.agent };
      config.writeConfig(updated);
      console.log(`Agent command updated to: ${options.agent}`);
      console.log(`Restart the daemon to use it: ${commandFor('stop', options.instance)} && ${commandFor('start', options.instance)}`);
      return;
    }
    console.log(`Already registered as "${existing.deviceName}" (${existing.deviceId}), running: ${existing.agentCommand}`);
    console.log(`Server: ${existing.serverUrl}`);
    return;
  }

  if (!options.agent) {
    console.error('Name the agent to run with --agent, e.g.:');
    console.error(`  ${BIN_NAME} register --agent "dsh acp"`);
    console.error(`  ${BIN_NAME} register --agent "qwen --acp"`);
    process.exit(1);
  }

  const agentName = await probe(options.agent);
  const serverUrl = options.server.replace(/\/$/, '');
  const bin = path.basename(parseCommandLine(options.agent)[0]);
  const deviceName = options.name || `${os.hostname()}-${bin}`;

  console.log(`\nRegistering "${deviceName}" for ${agentName} with ${serverUrl}...\n`);

  let result;
  try {
    // The app labels a device "<agent type> on <hostname>", and every ACP agent shares
    // one agent type, so the hostname it gets carries which agent this is.
    result = await registerDevice(serverUrl, deviceName, deviceName, AGENT_TYPE, displayVerification);
  } catch (err) {
    console.error('\nRegistration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (!result) {
    console.error('\nVerification code expired. Please try again.');
    process.exit(1);
  }

  const registered: AcpConfig = { serverUrl, deviceId: result.deviceId, deviceName, agentCommand: options.agent };
  config.writeConfig(registered);
  config.writeCredentials({ refreshToken: result.refreshToken });

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${result.deviceId}`);
  console.log(`\nRun '${commandFor('start', options.instance)}' to connect.`);
}

/** Start the agent once and complete the ACP handshake, so a typo fails here rather than on the phone. */
async function probe(command: string): Promise<string> {
  let argv: string[];
  try {
    argv = parseCommandLine(command);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  console.log(`Checking that "${command}" speaks ACP...`);
  const agent = new AcpAgent(argv, {
    update: () => undefined,
    permission: async () => ({ outcome: 'cancelled' }),
    requestWithdrawn: () => undefined,
    exited: () => undefined,
  }, DAEMON_VERSION, () => undefined);
  try {
    const init = await agent.start();
    const name = init.agentInfo?.title || init.agentInfo?.name || path.basename(argv[0]);
    console.log(`Found ${name}${init.agentInfo?.version ? ` ${init.agentInfo.version}` : ''}.`);
    return name;
  } catch (err) {
    console.error(`"${command}" did not start as an ACP agent: ${(err as Error).message}`);
    console.error('Check the command runs in this shell, and that it is the one that starts ACP mode.');
    process.exit(1);
  } finally {
    agent.stop();
  }
}
