import {
  readConfig,
  readCredentials,
  isRegistered,
  isDaemonRunning,
  readPidFile,
  vscodeStorageExists,
} from '../config/config';
import { getCDPClient } from '../adapter/cdp-client';
import { getSessionWatcher } from '../adapter/session-watcher';
import { discoverSessions } from '../session-discovery';

/**
 * Status command - check daemon and CDP connection status
 */
export async function status(): Promise<void> {
  console.log('CmdCtrl VS Code Copilot Daemon Status\n');

  // Registration status
  if (!isRegistered()) {
    console.log('Registration: Not registered');
    console.log('\nRun "cmdctrl-vscode-copilot register" to register this device.');
    return;
  }

  const config = readConfig()!;
  const credentials = readCredentials()!;

  console.log('Registration: Registered');
  console.log(`  Server: ${config.serverUrl}`);
  console.log(`  Device: ${config.deviceName}`);
  console.log(`  Device ID: ${config.deviceId}`);

  // Token status
  const tokenExpired = credentials.expiresAt < Date.now();
  console.log(`\nToken: ${tokenExpired ? 'Expired' : 'Valid'}`);
  if (!tokenExpired) {
    const expiresIn = Math.round((credentials.expiresAt - Date.now()) / 1000 / 60);
    console.log(`  Expires in: ${expiresIn} minutes`);
  }

  // Daemon status
  const running = isDaemonRunning();
  console.log(`\nDaemon: ${running ? 'Running' : 'Stopped'}`);
  if (running) {
    const pid = readPidFile();
    console.log(`  PID: ${pid}`);
  }

  // VS Code storage status
  const storageExists = vscodeStorageExists();
  console.log(`\nVS Code Storage: ${storageExists ? 'Found' : 'Not found'}`);
  if (storageExists) {
    try {
      const sessions = discoverSessions();
      console.log(`  Copilot Chat sessions: ${sessions.length}`);
      if (sessions.length > 0) {
        const recent = sessions.slice(0, 3);
        recent.forEach(s => {
          console.log(`    - ${s.title} (${s.project_name})`);
        });
        if (sessions.length > 3) {
          console.log(`    ... and ${sessions.length - 3} more`);
        }
      }
    } catch (err) {
      console.log(`  Error reading sessions: ${(err as Error).message}`);
    }
  }

  // CDP status
  console.log('\nCDP (Chrome DevTools Protocol):');
  try {
    const cdp = getCDPClient();
    const available = await cdp.isAvailable();
    if (available) {
      console.log('  Status: Available');
      const title = await cdp.getWindowTitle();
      if (title) {
        console.log(`  Active project: ${title}`);
      }
      await cdp.connect();
      const chatOpen = await cdp.isChatOpen();
      console.log(`  Copilot Chat panel: ${chatOpen ? 'Open' : 'Closed'}`);
      cdp.disconnect();
    } else {
      console.log('  Status: Not available');
      console.log('  To enable, start VS Code with:');
      console.log('    code --remote-debugging-port=9223');
    }
  } catch (err) {
    console.log(`  Status: Error - ${(err as Error).message}`);
  }
}
