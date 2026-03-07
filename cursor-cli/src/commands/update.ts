import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@cmdctrl/daemon-sdk';
import { stop } from './stop';

const configManager = new ConfigManager('cursor-cli');

// Get the current version from package.json
function getCurrentVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf-8'));
    return pkg.version;
  } catch {
    try {
      const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
      return pkg.version;
    } catch {
      return 'unknown';
    }
  }
}

// Fetch the latest version from npm registry
async function getLatestVersion(packageName: string): Promise<string | null> {
  try {
    const response = await fetch(`https://registry.npmjs.org/${packageName}/latest`);
    if (!response.ok) return null;
    const data = await response.json() as { version: string };
    return data.version;
  } catch {
    return null;
  }
}

export async function update(): Promise<void> {
  const packageName = '@cmdctrl/cursor-cli';
  const currentVersion = getCurrentVersion();
  const wasRunning = configManager.isDaemonRunning();

  console.log(`Current version: ${currentVersion}`);
  console.log(`Checking for updates...`);

  const latestVersion = await getLatestVersion(packageName);

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
    stop();
    // Wait for stop to complete (uses setTimeout internally)
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log(`Updating ${packageName}: v${currentVersion} → v${latestVersion}`);

  try {
    execSync(`npm install -g ${packageName}@latest`, {
      stdio: 'inherit',
    });
  } catch {
    console.error('\nUpdate failed. You may need to run with sudo:');
    console.error(`  sudo npm install -g ${packageName}@latest`);
    process.exit(1);
  }

  // Verify the update
  try {
    const result = execSync(`cmdctrl-cursor-cli --version`, { encoding: 'utf-8' }).trim();
    console.log(`\nUpdated successfully to v${result}`);
  } catch {
    console.log(`\nUpdate installed. Run 'cmdctrl-cursor-cli --version' to verify.`);
  }

  // Restart daemon if it was running before update
  if (wasRunning) {
    console.log('Restarting daemon...');
    const child = spawn('cmdctrl-cursor-cli', ['start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('Daemon restarted.');
  }
}
