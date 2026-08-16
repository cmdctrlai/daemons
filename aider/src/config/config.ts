import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawnDetached as sdkSpawnDetached } from '@cmdctrl/daemon-sdk';

export interface CmdCtrlConfig {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
}

const CONFIG_DIR = path.join(os.homedir(), '.cmdctrl-aider');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const SESSION_SALT_FILE = path.join(CONFIG_DIR, 'session-salt');

/**
 * Ensure the config directory exists with proper permissions
 */
export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700 });
  }
}

/**
 * Read the config file
 */
export function readConfig(): CmdCtrlConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return null;
    }
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as CmdCtrlConfig;
  } catch {
    return null;
  }
}

/**
 * Write the config file
 */
export function writeConfig(config: CmdCtrlConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Read credentials (access/refresh tokens)
 */
export function readCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) {
      return null;
    }
    const content = fs.readFileSync(CREDENTIALS_FILE, 'utf-8');
    return JSON.parse(content) as Credentials;
  } catch {
    return null;
  }
}

/**
 * Write credentials with restrictive permissions (600)
 */
export function writeCredentials(creds: Credentials): void {
  ensureConfigDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

/**
 * Delete credentials (for logout/revoke)
 */
export function deleteCredentials(): void {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
  }
}

/**
 * Delete config file (for unregister)
 */
export function deleteConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
}

/**
 * Check if device is registered
 */
export function isRegistered(): boolean {
  const config = readConfig();
  const creds = readCredentials();
  return config !== null && creds !== null && config.deviceId !== '';
}

/**
 * Write daemon PID file
 */
export function writePidFile(pid: number): void {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, pid.toString(), { mode: 0o600 });
}

/**
 * Read daemon PID
 */
export function readPidFile(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) {
      return null;
    }
    const content = fs.readFileSync(PID_FILE, 'utf-8');
    return parseInt(content, 10);
  } catch {
    return null;
  }
}

/**
 * Delete PID file
 */
export function deletePidFile(): void {
  if (fs.existsSync(PID_FILE)) {
    fs.unlinkSync(PID_FILE);
  }
}

/**
 * Relaunch this process detached, writing the child's pid to PID_FILE.
 */
export function spawnDetached() {
  return sdkSpawnDetached(CONFIG_DIR, PID_FILE);
}

/**
 * Check if daemon is running
 */
export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) {
    return false;
  }
  // A detached child sees its own pid in the pidfile (the parent wrote it
  // before exiting) – that's this process starting up, not another instance.
  if (pid === process.pid) {
    return false;
  }
  try {
    // Signal 0 doesn't kill, just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    // Process doesn't exist, clean up stale PID file
    deletePidFile();
    return false;
  }
}

/**
 * Read the persisted per-device salt used to derive discovered session IDs,
 * creating it on first use. The salt keeps a session's native ID from being
 * derivable from public inputs (history file path + start time) alone.
 *
 * It must never rotate: the same session is re-discovered from disk on every
 * restart and must yield the same ID, so a changed salt would orphan every
 * existing session.
 */
export function getSessionSalt(): string {
  try {
    const existing = fs.readFileSync(SESSION_SALT_FILE, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // Not created yet – fall through and generate one.
  }
  ensureConfigDir();
  const salt = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SESSION_SALT_FILE, salt, { mode: 0o600 });
  return salt;
}

export { CONFIG_DIR, CONFIG_FILE, CREDENTIALS_FILE, PID_FILE, SESSION_SALT_FILE };
