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
  expiresAt: number; // Unix timestamp
}

const CONFIG_DIR = path.join(os.homedir(), '.cmdctrl-vscode-copilot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

// VS Code data paths (macOS)
// Linux: ~/.config/Code/User/...
// Windows: %APPDATA%/Code/User/...
function getVSCodeBasePath(): string {
  switch (process.platform) {
    case 'darwin':
      return path.join(os.homedir(), 'Library/Application Support/Code/User');
    case 'linux':
      return path.join(os.homedir(), '.config/Code/User');
    case 'win32':
      return path.join(process.env.APPDATA || '', 'Code/User');
    default:
      return path.join(os.homedir(), '.config/Code/User');
  }
}

export const VSCODE_USER_PATH = getVSCodeBasePath();
export const VSCODE_GLOBAL_STORAGE = path.join(VSCODE_USER_PATH, 'globalStorage/state.vscdb');
export const VSCODE_WORKSPACE_STORAGE = path.join(VSCODE_USER_PATH, 'workspaceStorage');

// CDP default port (9223 to avoid conflict with Cursor which uses 9222)
export const CDP_PORT = 9223;
export const CDP_URL = `http://localhost:${CDP_PORT}`;

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
 * Check if daemon is running
 */
export function isDaemonRunning(): boolean {
  const pid = readPidFile();
  if (pid === null) {
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
 * Check if VS Code workspace storage exists
 */
export function vscodeStorageExists(): boolean {
  return fs.existsSync(VSCODE_WORKSPACE_STORAGE);
}

/**
 * Get all workspace storage directories
 */
export function getWorkspaceStorageDirs(): string[] {
  if (!fs.existsSync(VSCODE_WORKSPACE_STORAGE)) {
    return [];
  }
  return fs.readdirSync(VSCODE_WORKSPACE_STORAGE)
    .map(dir => path.join(VSCODE_WORKSPACE_STORAGE, dir))
    .filter(dir => fs.statSync(dir).isDirectory());
}

export { CONFIG_DIR, CONFIG_FILE, CREDENTIALS_FILE, PID_FILE };
