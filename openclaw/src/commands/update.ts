import { execSync, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfigManager } from '@cmdctrl/daemon-sdk';
import { stop } from './stop';

const configManager = new ConfigManager('openclaw');

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
  const packageName = '@cmdctrl/openclaw';
  const currentVersion = getCurrentVersion();
  const wasRunning = configManager.isDaemonRunning();

  console.log(`Current version: ${currentVersion}`);
  console.log('Checking for updates...');

  const latestVersion = await getLatestVersion(packageName);

  if (!latestVersion) {
    console.error('Failed to check for updates. Check your internet connection.');
    process.exit(1);
  }

  if (currentVersion === latestVersion) {
    console.log(`Already up to date (v${currentVersion}).`);
    return;
  }

  if (wasRunning) {
    console.log('Stopping daemon before update...');
    stop();
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log(`Updating ${packageName}: v${currentVersion} \u2192 v${latestVersion}`);

  try {
    execSync(`npm install -g ${packageName}@latest`, { stdio: 'inherit' });
  } catch {
    console.error('\nUpdate failed. You may need to run with sudo:');
    console.error(`  sudo npm install -g ${packageName}@latest`);
    process.exit(1);
  }

  try {
    const result = execSync('cmdctrl-openclaw --version', { encoding: 'utf-8' }).trim();
    console.log(`\nUpdated successfully to v${result}`);
  } catch {
    console.log("\nUpdate installed. Run 'cmdctrl-openclaw --version' to verify.");
  }

  if (wasRunning) {
    console.log('Restarting daemon...');
    const child = spawn('cmdctrl-openclaw', ['start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    console.log('Daemon restarted.');
  }
}
