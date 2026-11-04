import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@cmdctrl/daemon-sdk';
import type { AgentFlavor } from './agent-flavor';

/** Which daemon this process runs as: `cmdctrl-pi`, or a package built on it such as `cmdctrl-omp`. */
export interface DaemonIdentity {
  /** Names the CLI (`cmdctrl-<name>`), its npm package (`@cmdctrl/<name>`) and config dir (`~/.cmdctrl-<name>`). */
  daemonName: string;
  /** The agent this daemon drives, and what the server files its devices and sessions under. */
  agentType: AgentFlavor;
  /** The agent CLI to run. The agent's own variable (`PI_BIN`, `OMP_BIN`) overrides it with a path. */
  bin: string;
  /** Overrides `~/.cmdctrl-<daemonName>`. */
  configDir?: string;
  /** The running package's version: reported to the server, and what a self-update is checked against. */
  version: string;
}

// Read from package.json rather than hardcoding. A constant that drifts below the
// published version makes the server push an update the new build also fails to
// satisfy, so the daemon reinstalls itself forever.
function packageVersion(): string {
  for (const rel of [['..', 'package.json'], ['..', '..', 'package.json']]) {
    try {
      return JSON.parse(readFileSync(join(__dirname, ...rel), 'utf-8')).version;
    } catch { /* try the next candidate */ }
  }
  return 'unknown';
}

export const PI_IDENTITY: DaemonIdentity = { daemonName: 'pi', agentType: 'pi', bin: 'pi', version: packageVersion() };

/** Each agent's CLI path override, so one set for pi never redirects the omp daemon. */
const BIN_ENVS: Record<AgentFlavor, string> = { pi: 'PI_BIN', omp: 'OMP_BIN' };

export let AGENT_TYPE: AgentFlavor;
export let DAEMON_VERSION: string;
export let CLI_NAME: string;
export let PACKAGE_NAME: string;
export let PI_BIN: string;
export let BIN_ENV: string;
export let config: ConfigManager;

/** Sets which daemon this process runs as. Call before running a command. */
export function useIdentity(identity: DaemonIdentity): void {
  AGENT_TYPE = identity.agentType;
  DAEMON_VERSION = identity.version;
  CLI_NAME = `cmdctrl-${identity.daemonName}`;
  PACKAGE_NAME = `@cmdctrl/${identity.daemonName}`;
  BIN_ENV = BIN_ENVS[identity.agentType];
  PI_BIN = process.env[BIN_ENV] || identity.bin;
  config = new ConfigManager(identity.daemonName, identity.configDir);
}

useIdentity(PI_IDENTITY);
