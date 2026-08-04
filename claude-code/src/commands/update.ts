import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fetchLatestVersion, selfUpdate } from '@cmdctrl/daemon-sdk';
import { isDaemonRunning } from '../config/config';
import { stop } from './stop';

const PACKAGE_NAME = '@cmdctrl/claude-code';
const BIN_NAME = 'cmdctrl-claude-code';

// Get the current version from package.json
function getCurrentVersion(): string {
  for (const rel of [['..', '..', 'package.json'], ['..', 'package.json']]) {
    try {
      return JSON.parse(readFileSync(join(__dirname, ...rel), 'utf-8')).version;
    } catch {
      continue;
    }
  }
  return 'unknown';
}

export async function update(): Promise<void> {
  const currentVersion = getCurrentVersion();
  const wasRunning = isDaemonRunning();

  console.log(`Current version: ${currentVersion}`);
  console.log(`Checking for updates...`);

  const latestVersion = await fetchLatestVersion(PACKAGE_NAME);

  if (!latestVersion) {
    console.error('Failed to check for updates. Check your internet connection.');
    process.exit(1);
  }

  if (currentVersion === latestVersion) {
    console.log(`Already up to date (v${currentVersion}).`);
    return;
  }

  // Stop daemon before updating so the old process doesn't hold stale code
  if (wasRunning) {
    console.log('Stopping daemon before update...');
    await stop();
  }

  console.log(`Updating ${PACKAGE_NAME}: v${currentVersion} → v${latestVersion}`);

  const result = await selfUpdate({
    packageName: PACKAGE_NAME,
    binName: BIN_NAME,
    currentVersion,
    latestVersion,
    restartAfter: wasRunning,
  });

  if (result.status === 'updated') {
    console.log(`\nUpdated successfully to v${result.toVersion}`);
    if (wasRunning) console.log('Daemon restarted.');
    return;
  }

  if (result.status === 'up-to-date') {
    console.log(`\nAlready up to date (v${result.toVersion}).`);
  } else {
    console.error(`\n${result.error ?? 'Update failed.'}`);
  }

  // selfUpdate only respawns after a successful install, so restore the daemon
  // ourselves when nothing was installed.
  if (wasRunning) {
    console.log('Restarting daemon...');
    const child = spawn(BIN_NAME, ['start'], { detached: true, stdio: 'ignore' });
    child.unref();
  }

  if (result.status !== 'up-to-date') process.exit(1);
}
