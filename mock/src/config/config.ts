import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CmdCtrlConfig {
  serverUrl: string;
  deviceId: string;
  deviceName: string;
}

export interface Credentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface MockConfig {
  // Timing (in milliseconds)
  responseDelayMs: { min: number; max: number };
  outputIntervalMs: { min: number; max: number };
  thinkingTimeMs: { min: number; max: number };

  // Event generation
  outputLineCount: { min: number; max: number };
  progressEventCount: { min: number; max: number };
  askQuestionProbability: number; // 0-1
  errorProbability: number; // 0-1

  // Content
  echoPrefix: string;
}

export const DEFAULT_MOCK_CONFIG: MockConfig = {
  responseDelayMs: { min: 100, max: 300 },
  outputIntervalMs: { min: 50, max: 100 },
  thinkingTimeMs: { min: 50, max: 150 },
  outputLineCount: { min: 1, max: 2 },
  progressEventCount: { min: 1, max: 2 },
  askQuestionProbability: 0,
  errorProbability: 0,
  echoPrefix: '**MOCK:** '
};

const CONFIG_DIR = path.join(os.homedir(), '.cmdctrl-mock');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');
const SESSIONS_DIR = path.join(os.homedir(), '.cmdctrl-mock', 'sessions');

/**
 * Ensure the config directory exists with proper permissions
 */
export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

/**
 * Ensure sessions directory exists
 */
export function ensureSessionsDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { mode: 0o700, recursive: true });
  }
}

/**
 * Get sessions directory path
 */
export function getSessionsDir(): string {
  return SESSIONS_DIR;
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
 * Delete credentials
 */
export function deleteCredentials(): void {
  if (fs.existsSync(CREDENTIALS_FILE)) {
    fs.unlinkSync(CREDENTIALS_FILE);
  }
}

/**
 * Delete config file
 */
export function deleteConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
}

/**
 * Clear all registration data (config and credentials)
 */
export function clearRegistration(): void {
  deleteConfig();
  deleteCredentials();
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
 * Check if daemon is running
 */
export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    deletePidFile();
    return false;
  }
}

export { CONFIG_DIR, CONFIG_FILE, CREDENTIALS_FILE, PID_FILE, SESSIONS_DIR };
