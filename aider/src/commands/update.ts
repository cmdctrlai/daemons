import { readFileSync } from 'fs';
import { join } from 'path';
import { selfUpdate } from '@cmdctrl/daemon-sdk';
import { isDaemonRunning } from '../config/config';
import { stop } from './stop';

const PACKAGE_NAME = '@cmdctrl/aider';
const BIN_NAME = 'cmdctrl-aider';

function getCurrentVersion(): string {
  for (const dir of ['..', '../..']) {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, dir, 'package.json'), 'utf-8'));
      if (pkg.name === PACKAGE_NAME) return pkg.version;
    } catch { /* try next */ }
  }
  return 'unknown';
}

export async function update(): Promise<void> {
  const currentVersion = getCurrentVersion();
  const wasRunning = isDaemonRunning();

  console.log(`Current version: ${currentVersion}`);
  console.log('Checking for updates...');

  if (wasRunning) {
    console.log('Stopping daemon before update...');
    await stop();
  }

  const result = await selfUpdate({
    packageName: PACKAGE_NAME,
    binName: BIN_NAME,
    currentVersion,
    restartAfter: wasRunning,
  });

  switch (result.status) {
    case 'up-to-date':
      console.log(`Already up to date (v${result.toVersion}).`);
      return;
    case 'updated':
      console.log(`\nUpdated v${result.fromVersion} → v${result.toVersion}.`);
      if (wasRunning) console.log('Daemon restarted.');
      return;
    case 'unsupported':
    case 'failed':
      console.error(`\n${result.error}`);
      process.exit(1);
  }
}
