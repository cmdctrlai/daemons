/**
 * Shared daemon context.
 *
 * Defines the identity of this daemon (name, agent type, version) and
 * exposes a single ConfigManager instance used by every command.
 *
 * To build your own daemon, change these constants to match your agent.
 */

import { ConfigManager } from '@cmdctrl/daemon-sdk';

/** Short name used for the config directory (~/.cmdctrl-<NAME>). */
export const DAEMON_NAME = 'example';

/** Agent type identifier sent to the server (snake_case, shown in the UI). */
export const AGENT_TYPE = 'example';

/** Your daemon's semantic version. Reported to the server on connect. */
export const DAEMON_VERSION = '1.1.0';

/** Single shared ConfigManager for all commands. */
export const config = new ConfigManager(DAEMON_NAME);
