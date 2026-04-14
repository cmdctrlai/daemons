import { ConfigManager } from '@cmdctrl/daemon-sdk';

export const DAEMON_NAME = 'pi';
export const AGENT_TYPE = 'pi';
export const DAEMON_VERSION = '0.1.0';

export const config = new ConfigManager(DAEMON_NAME);

/** Path to the `pi` executable. Override with PI_BIN env var. */
export const PI_BIN = process.env.PI_BIN || 'pi';
