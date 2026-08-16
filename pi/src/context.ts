import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@cmdctrl/daemon-sdk';

export const DAEMON_NAME = 'pi';
export const AGENT_TYPE = 'pi';

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

export const config = new ConfigManager(DAEMON_NAME);

/** Path to the `pi` executable. Override with PI_BIN env var. */
export const PI_BIN = process.env.PI_BIN || 'pi';
