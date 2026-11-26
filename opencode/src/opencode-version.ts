/**
 * Which opencode the daemon would run, and whether it can drive it. Each major
 * version has its own server API, so against one the daemon doesn't speak it
 * says so rather than starting a server whose every request fails.
 */
import { execFile } from 'child_process';
import type { DaemonClient } from '@cmdctrl/daemon-sdk';
import { opencodeEnv } from './adapter/opencode';

const LATEST_SUPPORTED_MAJOR = 2;
const VERSION_TIMEOUT_MS = 15_000;

/** The version `opencode --version` printed, if it printed one. */
export function parseVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0];
}

/** The major version, or undefined when the version is unknown. */
export function majorVersion(version: string | undefined): number | undefined {
  const major = Number(version?.split('.')[0]);
  return Number.isInteger(major) ? major : undefined;
}

/** Why this opencode can't be used, for the user; undefined when it can or the version is unknown. */
export function unsupportedReason(version: string | undefined): string | undefined {
  const major = majorVersion(version);
  if (major === undefined || major <= LATEST_SUPPORTED_MAJOR) return undefined;
  return `opencode v${major} isn't supported yet – CmdCtrl works with opencode 1.x and 2.x`;
}

/** The version of the opencode binary the daemon would run; undefined when it can't tell. */
export function opencodeVersion(env: NodeJS.ProcessEnv = opencodeEnv()): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('opencode', ['--version'], { env, timeout: VERSION_TIMEOUT_MS }, (err, stdout) => {
      resolve(err ? undefined : parseVersion(String(stdout)));
    });
  });
}

/**
 * Check the opencode this daemon would run. When it can't drive it, tell the user
 * through log, in whatever terminal started it. Returns the version and why not.
 */
export async function checkOpencode(
  log: (line: string) => void = console.error,
  env?: NodeJS.ProcessEnv,
): Promise<{ version?: string; reason?: string }> {
  const version = await opencodeVersion(env);
  const reason = unsupportedReason(version);
  if (reason) {
    log(`${reason}. Found opencode ${version}.`);
    log('The app shows the same when you start a session. Restart cmdctrl-opencode once opencode 1.x or 2.x is installed.');
  }
  return { version, reason };
}

/** With an opencode the daemon can't drive, every task the user starts or replies to ends with the reason. */
export function refuseTasks(client: Pick<DaemonClient, 'onTaskStart' | 'onTaskResume'>, reason: string): void {
  client.onTaskStart((task) => task.error(reason));
  client.onTaskResume((task) => task.error(reason));
}
