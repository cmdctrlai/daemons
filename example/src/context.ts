/**
 * Shared daemon context.
 *
 * Defines the identity of this daemon (name, agent type, version) and
 * exposes a single ConfigManager instance used by every command.
 *
 * To build your own daemon, change these constants to match your agent.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@cmdctrl/daemon-sdk';

/** Short name used for the config directory (~/.cmdctrl-<NAME>). */
export const DAEMON_NAME = 'example';

/** Agent type identifier sent to the server (snake_case, shown in the UI). */
export const AGENT_TYPE = 'example';

/**
 * Your daemon's semantic version. Reported to the server on connect.
 *
 * Read it from package.json - never hardcode it. If the constant falls behind
 * the published version, the server sees an outdated daemon and pushes an
 * update that the newly installed build still fails to satisfy, so the daemon
 * reinstalls itself in a loop.
 */
function packageVersion(): string {
  for (const rel of [['..', 'package.json'], ['..', '..', 'package.json']]) {
    try {
      return JSON.parse(readFileSync(join(__dirname, ...rel), 'utf-8')).version;
    } catch { /* try the next candidate */ }
  }
  return 'unknown';
}

export const DAEMON_VERSION = packageVersion();

/** Single shared ConfigManager for all commands. */
export const config = new ConfigManager(DAEMON_NAME);
