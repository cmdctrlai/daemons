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

const CONFIG_DIR = path.join(os.homedir(), '.cmdctrl-gemini-cli');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const CREDENTIALS_FILE = path.join(CONFIG_DIR, 'credentials');
const PID_FILE = path.join(CONFIG_DIR, 'daemon.pid');

export function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { mode: 0o700, recursive: true });
  }
}

export function readConfig(): CmdCtrlConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeConfig(config: CmdCtrlConfig): void {
  ensureConfigDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function readCredentials(): Credentials | null {
  try {
    if (!fs.existsSync(CREDENTIALS_FILE)) return null;
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function writeCredentials(creds: Credentials): void {
  ensureConfigDir();
  fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), { mode: 0o600 });
}

export function deleteCredentials(): void {
  try { fs.unlinkSync(CREDENTIALS_FILE); } catch { /* ok */ }
}

export function deleteConfig(): void {
  try { fs.unlinkSync(CONFIG_FILE); } catch { /* ok */ }
}

export function clearRegistration(): void {
  deleteConfig();
  deleteCredentials();
}

export function isRegistered(): boolean {
  const config = readConfig();
  const creds = readCredentials();
  return config !== null && creds !== null && config.deviceId !== '';
}

export function writePidFile(pid: number): void {
  ensureConfigDir();
  fs.writeFileSync(PID_FILE, pid.toString(), { mode: 0o600 });
}

export function readPidFile(): number | null {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
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

export { CONFIG_DIR, CONFIG_FILE, CREDENTIALS_FILE, PID_FILE };
