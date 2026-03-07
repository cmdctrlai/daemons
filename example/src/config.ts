/**
 * Configuration and credential management.
 *
 * Stores config in ~/.cmdctrl-example/:
 *   config.json  - Server URL, device ID, device name
 *   credentials  - Refresh token (chmod 600)
 *   daemon.pid   - PID of running daemon
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Change this to match your daemon name
const DAEMON_NAME = 'cmdctrl-example';

const CONFIG_DIR = path.join(os.homedir(), `.${DAEMON_NAME}`);
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

export interface Config {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
}

export interface Credentials {
  refreshToken: string;
}

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function readConfig(): Config | null {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeConfig(config: Config): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function readCredentials(): Credentials | null {
  try {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  ensureConfigDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function isRegistered(): boolean {
  const config = readConfig();
  const creds = readCredentials();
  return config !== null && creds !== null && config.deviceId !== '';
}

export function clearRegistration(): void {
  try { fs.unlinkSync(CONFIG_FILE); } catch { /* ok */ }
  try { fs.unlinkSync(CREDENTIALS_FILE); } catch { /* ok */ }
}

export function writePidFile(pid: number): void {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, pid.toString(), { mode: 0o600 });
}

export function readPidFile(): number | null {
  try {
    return parseInt(fs.readFileSync(PID_FILE, 'utf-8'), 10);
  } catch {
    return null;
  }
}

export function deletePidFile(): void {
  try { fs.unlinkSync(PID_FILE); } catch { /* ok */ }
}

export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    deletePidFile();
    return false;
  }
}
