/**
 * Register – check the agent command speaks ACP, then run the device
 * authorization flow and store the command with the registration.
 */
import * as os from 'os';
import * as path from 'path';
import { registerDevice, displayVerification } from '@cmdctrl/daemon-sdk';
import * as readline from 'readline/promises';
import { AcpAgent } from '../agent';
import { agentTypeFor, detectAgents, isEditorLauncher, KNOWN_AGENTS, pinShadowedBin, resolveBin, type KnownAgent } from '../detect';
import { parseCommandLine } from '../command-line';
import { BIN_NAME, DAEMON_VERSION, commandFor, configFor, readAcpConfig, type AcpConfig } from '../context';

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
      if (isDifferentAgent(existing, options.agent)) {
        console.error(`"${options.agent}" is a different agent from "${existing.agentCommand}", and the app names each device after its agent.`);
        console.error(`Run '${commandFor('unregister', options.instance)}' first, or register it alongside with --instance <name>.`);
        process.exit(1);
      }
      await probe(options.agent);
      const agentCommand = pinShadowedBin(options.agent);
      const updated: AcpConfig = { ...existing, agentCommand };
      config.writeConfig(updated);
      console.log(`Agent command updated to: ${agentCommand}`);
      console.log(`Restart the daemon to use it: ${commandFor('stop', options.instance)} && ${commandFor('start', options.instance)}`);
      return;
    }
    console.log(`Already registered as "${existing.deviceName}" (${existing.deviceId}), running: ${existing.agentCommand}`);
    console.log(`Server: ${existing.serverUrl}`);
    return;
  }

  let agentCommand = options.agent;
  if (!agentCommand) {
    const found = detectAgents();
    if (found.length === 0) {
      console.error('No known ACP agent found on PATH. Name the one to run with --agent, e.g.:');
      for (const known of KNOWN_AGENTS) console.error(`  ${BIN_NAME} register --agent "${known.command}"`);
      process.exit(1);
    }
    agentCommand = await chooseAgent(found);
    if (!agentCommand) process.exit(1);
  }

  // A found binary can share a name with something else (Homebrew's goose is a migration tool).
  const hint = options.agent ? undefined : `Not that one? Name the agent with: ${BIN_NAME} register --agent "<command>"`;
  const agentName = await probe(agentCommand, hint);
  agentCommand = pinShadowedBin(agentCommand);
  const serverUrl = options.server.replace(/\/$/, '');
  const bin = path.basename(parseCommandLine(agentCommand)[0]);
  const deviceName = options.name || `${os.hostname()}-${bin}`;

  const agentType = agentTypeFor(agentCommand);
  console.log(`\nRegistering "${deviceName}" for ${agentName} with ${serverUrl}...\n`);

  let result;
  try {
    result = await registerDevice(serverUrl, deviceName, deviceName, agentType, displayVerification);
  } catch (err) {
    console.error('\nRegistration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (!result) {
    console.error('\nVerification code expired. Please try again.');
    process.exit(1);
  }

  const registered: AcpConfig = { serverUrl, deviceId: result.deviceId, deviceName, agentCommand, agentType };
  config.writeConfig(registered);
  config.writeCredentials({ refreshToken: result.refreshToken });

  console.log('\n\nRegistration complete!');
  console.log(`Device ID: ${result.deviceId}`);
  console.log(`\nRun '${commandFor('start', options.instance)}' to connect.`);
}

/** Whether a new agent command starts a different binary than the registered one; the device is named after it. */
export function isDifferentAgent(existing: Pick<AcpConfig, 'agentCommand'>, agentCommand: string): boolean {
  return binOf(agentCommand) !== binOf(existing.agentCommand);
}

function binOf(command: string): string | undefined {
  try {
    return path.basename(parseCommandLine(command)[0]);
  } catch {
    return undefined;
  }
}

/**
 * The command for one of the agents found on PATH: the only one, or the one picked
 * from a numbered list. Undefined when none was found or no choice could be made.
 */
export async function chooseAgent(
  found: KnownAgent[],
  ask: ((question: string) => Promise<string>) | undefined = process.stdin.isTTY ? askOnTerminal : undefined,
): Promise<string | undefined> {
  if (found.length === 0) return undefined;
  if (found.length === 1) {
    console.log(`Found ${found[0].name} – running: ${found[0].command}`);
    return found[0].command;
  }
  console.log('Found more than one ACP agent:');
  found.forEach((agent, i) => console.log(`  ${i + 1}) ${agent.name}  (${agent.command})`));
  if (!ask) {
    console.log('Pick one with --agent.');
    return undefined;
  }
  const answer = (await ask(`Which one? [1-${found.length}]: `)).trim();
  const picked = /^\d+$/.test(answer) ? found[Number(answer) - 1] : undefined;
  if (!picked) console.log(answer ? `Not a choice: ${answer}` : 'No agent picked.');
  return picked?.command;
}

async function askOnTerminal(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } catch {
    return ''; // Ctrl+D or Ctrl+C at the prompt: no choice
  } finally {
    rl.close();
  }
}

/** Start the agent once and complete the ACP handshake, so a typo fails here rather than on the phone. */
async function probe(command: string, hint?: string): Promise<string> {
  let argv: string[];
  try {
    argv = parseCommandLine(command);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
  const resolved = resolveBin(argv[0]);
  if (resolved && isEditorLauncher(resolved)) {
    console.error(`"${resolved}" is an editor launcher, not an ACP agent – it would open an editor window.`);
    console.error('Name the agent by full path. For Antigravity, install its CLI and use: --agent "$HOME/.local/bin/agy acp"');
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
    console.error(hint ?? 'Check the command runs in this shell, and that it is the one that starts ACP mode.');
    process.exit(1);
  } finally {
    agent.stop();
  }
}
