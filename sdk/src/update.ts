/**
 * Self-update utility for CmdCtrl daemons.
 *
 * Provides a single shared implementation of "check npm for the latest
 * version of this package and install it globally." Used by:
 *   - The `update` CLI command in each daemon (manual user-triggered update)
 *   - The DaemonClient auto-update path (server pushes update_available)
 *
 * Auto-update is unsupported on Windows because the running daemon's
 * launcher .exe shim is locked while it executes – a global npm install
 * will fail. On Windows callers should instruct the user to update manually.
 */

import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface SelfUpdateOptions {
  /** npm package name, e.g. '@cmdctrl/aider' */
  packageName: string;
  /** Installed binary name, e.g. 'cmdctrl-aider' */
  binName: string;
  /** Version string the daemon believes it is running. */
  currentVersion: string;
  /**
   * Spawn `<binName> start` after a successful install. Defaults to false –
   * the calling context decides whether a fresh daemon should be started.
   */
  restartAfter?: boolean;
  /** Pre-fetched latest version. If omitted, queries npm registry. */
  latestVersion?: string;
}

export type SelfUpdateStatus = 'up-to-date' | 'updated' | 'failed' | 'unsupported';

export interface SelfUpdateResult {
  status: SelfUpdateStatus;
  fromVersion: string;
  toVersion?: string;
  error?: string;
}

/** Returns true on platforms where in-place global npm install is safe. */
export function isAutoUpdateSupported(): boolean {
  return process.platform !== 'win32';
}

/** Query the npm registry for the latest published version of a package. */
export async function fetchLatestVersion(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!response.ok) return null;
    const data = await response.json() as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

/**
 * Update the package in place. Caller is responsible for stopping any
 * existing daemon process before invoking this (the running process holds
 * no node_modules locks on macOS/Linux, so updating from inside a running
 * daemon is fine, but a separate stop+start dance keeps the pid file sane).
 */
export async function selfUpdate(opts: SelfUpdateOptions): Promise<SelfUpdateResult> {
  if (!isAutoUpdateSupported()) {
    return {
      status: 'unsupported',
      fromVersion: opts.currentVersion,
      error: 'Auto-update is not supported on Windows. Run `npm install -g ' + opts.packageName + '@latest` manually.',
    };
  }

  const latest = opts.latestVersion ?? await fetchLatestVersion(opts.packageName);
  if (!latest) {
    return {
      status: 'failed',
      fromVersion: opts.currentVersion,
      error: 'Failed to query npm registry. Check your internet connection.',
    };
  }

  if (latest === opts.currentVersion) {
    return { status: 'up-to-date', fromVersion: opts.currentVersion, toVersion: latest };
  }

  try {
    execSync(`npm install -g ${opts.packageName}@latest`, { stdio: 'inherit' });
  } catch {
    return {
      status: 'failed',
      fromVersion: opts.currentVersion,
      toVersion: latest,
      error: `npm install failed. You may need: sudo npm install -g ${opts.packageName}@latest`,
    };
  }

  // Read the actually-installed version. npm install -g @pkg@latest can
  // install a different version than `latest` here implied (e.g. if the
  // server's policy advertised a version that isn't actually published).
  // Reporting the post-install reality avoids misleading log lines.
  const installedVersion = readInstalledGlobalVersion(opts.packageName) ?? latest;

  if (installedVersion === opts.currentVersion) {
    return { status: 'up-to-date', fromVersion: opts.currentVersion, toVersion: installedVersion };
  }

  if (opts.restartAfter) {
    const child = spawn(opts.binName, ['start'], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  return { status: 'updated', fromVersion: opts.currentVersion, toVersion: installedVersion };
}

/** Read the installed version of a globally-installed npm package, or null. */
function readInstalledGlobalVersion(packageName: string): string | null {
  try {
    const npmRoot = execSync('npm root -g', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pkg = JSON.parse(readFileSync(join(npmRoot, packageName, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}
