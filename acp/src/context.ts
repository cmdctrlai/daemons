import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager, type DaemonConfig } from '@cmdctrl/daemon-sdk';

export const AGENT_TYPE = 'acp';
export const PACKAGE_NAME = '@cmdctrl/acp';
export const BIN_NAME = 'cmdctrl-acp';

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

export const DAEMON_VERSION = packageVersion();

/** config.json, plus the agent this registration launches. */
export interface AcpConfig extends DaemonConfig {
  /** The command that starts the agent in ACP mode, e.g. `dsh acp`. */
  agentCommand: string;
}

/**
 * One registration per agent. The default lives in `~/.cmdctrl-acp/`; a named
 * instance (`--instance qwen`) in `~/.cmdctrl-acp-qwen/`, so two agents on one
 * machine are two devices with their own daemons.
 */
export function configFor(instance?: string): ConfigManager {
  if (instance !== undefined && !/^[a-z0-9][a-z0-9_-]*$/i.test(instance)) {
    throw new Error(`Instance names are letters, digits, "-" and "_": "${instance}"`);
  }
  return new ConfigManager(instance ? `acp-${instance}` : 'acp');
}

/** Where a started daemon records its instance, for the processes it starts. */
export const INSTANCE_ENV = 'CMDCTRL_ACP_INSTANCE';

/**
 * The instance `start` runs: the flag, else the one a parent daemon recorded.
 * An auto-update respawns `cmdctrl-acp start` with no arguments, so a named
 * instance would otherwise come back as the default one.
 */
export function startInstance(flag: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return flag || env[INSTANCE_ENV] || undefined;
}

export function readAcpConfig(config: ConfigManager): AcpConfig | null {
  const raw = config.readConfig() as AcpConfig | null;
  return raw && typeof raw.agentCommand === 'string' && raw.agentCommand.trim() ? raw : null;
}

/** A subcommand as the user types it for this instance, for messages: `cmdctrl-acp start --instance qwen`. */
export function commandFor(subcommand: string, instance?: string): string {
  return `${BIN_NAME} ${subcommand}${instance ? ` --instance ${instance}` : ''}`;
}
