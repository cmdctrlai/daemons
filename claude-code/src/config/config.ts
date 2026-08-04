/**
 * Config and credential storage for the Claude Code daemon.
 *
 * A thin module-level façade over the SDK's ConfigManager so every command
 * keeps calling plain functions. `CMDCTRL_DAEMON_CONFIG_DIR` points the whole
 * layout somewhere else, which is how a second daemon instance runs against a
 * different server without disturbing the primary registration.
 */

import { ConfigManager, DaemonConfig, DaemonCredentials } from '@cmdctrl/daemon-sdk';

export type CmdCtrlConfig = DaemonConfig;
export type Credentials = DaemonCredentials;

const manager = new ConfigManager('claude-code', process.env.CMDCTRL_DAEMON_CONFIG_DIR);

export const CONFIG_DIR = manager.configDir;
export const CONFIG_FILE = manager.configFile;
export const CREDENTIALS_FILE = manager.credentialsFile;
export const PID_FILE = manager.pidFile;

export function readConfig(): CmdCtrlConfig | null {
  return manager.readConfig();
}

export function writeConfig(config: CmdCtrlConfig): void {
  manager.writeConfig(config);
}

export function readCredentials(): Credentials | null {
  return manager.readCredentials();
}

export function writeCredentials(creds: Credentials): void {
  manager.writeCredentials(creds);
}

export function clearRegistration(): void {
  manager.clearRegistration();
}

export function isRegistered(): boolean {
  return manager.isRegistered();
}

export function writePidFile(pid: number): void {
  manager.writePidFile(pid);
}

export function readPidFile(): number | null {
  return manager.readPidFile();
}

export function deletePidFile(): void {
  manager.deletePidFile();
}

export function isDaemonRunning(): boolean {
  return manager.isDaemonRunning();
}
