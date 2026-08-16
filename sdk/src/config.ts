/**
 * Configuration and credential management utilities.
 *
 * Provides a standard config directory layout used by all CmdCtrl daemons:
 *   ~/.cmdctrl-<name>/config.json   - Server URL, device ID, device name
 *   ~/.cmdctrl-<name>/credentials   - Refresh token (chmod 600)
 *   ~/.cmdctrl-<name>/daemon.pid    - PID of running daemon process
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

export interface DaemonConfig {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
}

export interface DaemonCredentials {
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface DetachResult {
  pid: number;
  logFile: string;
}

/**
 * Re-launches the current process detached from the controlling terminal.
 * The parent is expected to print the result and exit; the child inherits
 * argv/env (with -d/--detach stripped, so it takes the default foreground
 * path) and gets its own session via `detached: true` + `unref()`.
 *
 * stdout/stderr are redirected to a log file – a detached child that
 * inherits a closed stdout can die on its first write.
 */
export function spawnDetached(configDir: string, pidFile: string): DetachResult {
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { mode: 0o700, recursive: true });
  }
  const logFile = path.join(configDir, 'daemon.log');
  const logFd = fs.openSync(logFile, 'a');

  const args = process.argv.slice(2).filter((a) => a !== '-d' && a !== '--detach');
  const child = spawn(process.argv[0], [process.argv[1], ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);
  child.unref();

  // The pidfile must describe the child – stop/status read it, and the
  // parent is about to exit.
  fs.writeFileSync(pidFile, String(child.pid), { mode: 0o600 });
  return { pid: child.pid!, logFile };
}

/**
 * Manages config files for a daemon.
 *
 * @example
 * ```typescript
 * const configManager = new ConfigManager('my-agent');
 * // Files stored in ~/.cmdctrl-my-agent/
 *
 * configManager.writeConfig({ serverUrl: '...', deviceId: '...', deviceName: '...' });
 * const config = configManager.readConfig();
 * ```
 *
 * Pass `configDir` to store the files somewhere else – e.g. to run a second
 * instance of the same daemon against a different server without disturbing
 * the primary registration.
 */
export class ConfigManager {
  readonly configDir: string;
  readonly configFile: string;
  readonly credentialsFile: string;
  readonly pidFile: string;

  constructor(daemonName: string, configDir?: string) {
    this.configDir = configDir || path.join(os.homedir(), `.cmdctrl-${daemonName}`);
    this.configFile = path.join(this.configDir, 'config.json');
    this.credentialsFile = path.join(this.configDir, 'credentials');
    this.pidFile = path.join(this.configDir, 'daemon.pid');
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { mode: 0o700, recursive: true });
    }
  }

  readConfig(): DaemonConfig | null {
    try {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  writeConfig(config: DaemonConfig): void {
    this.ensureDir();
    fs.writeFileSync(this.configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
  }

  readCredentials(): DaemonCredentials | null {
    try {
      return JSON.parse(fs.readFileSync(this.credentialsFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  writeCredentials(creds: DaemonCredentials): void {
    this.ensureDir();
    fs.writeFileSync(this.credentialsFile, JSON.stringify(creds, null, 2), { mode: 0o600 });
  }

  isRegistered(): boolean {
    const config = this.readConfig();
    const creds = this.readCredentials();
    return config !== null && creds !== null && config.deviceId !== '';
  }

  clearRegistration(): void {
    try { fs.unlinkSync(this.configFile); } catch { /* ok */ }
    try { fs.unlinkSync(this.credentialsFile); } catch { /* ok */ }
  }

  writePidFile(pid: number): void {
    this.ensureDir();
    fs.writeFileSync(this.pidFile, pid.toString(), { mode: 0o600 });
  }

  /** Relaunch the current process detached; see `spawnDetached()`. */
  spawnDetached(): DetachResult {
    return spawnDetached(this.configDir, this.pidFile);
  }

  readPidFile(): number | null {
    try {
      return parseInt(fs.readFileSync(this.pidFile, 'utf-8'), 10);
    } catch {
      return null;
    }
  }

  deletePidFile(): void {
    try { fs.unlinkSync(this.pidFile); } catch { /* ok */ }
  }

  isDaemonRunning(): boolean {
    const pid = this.readPidFile();
    if (pid === null) return false;
    // A detached child sees its own pid in the pidfile (the parent wrote it
    // before exiting) – that's this process starting up, not another instance.
    if (pid === process.pid) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      this.deletePidFile();
      return false;
    }
  }
}
