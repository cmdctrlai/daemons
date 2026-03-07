import {
  readConfig,
  readCredentials,
  isRegistered,
  isDaemonRunning,
  readPidFile,
  cursorDbExists,
} from '../config/config';
import { getCDPClient } from '../adapter/cdp-client';
import { getCursorDB } from '../adapter/cursor-db';

/**
 * Status command - check daemon and CDP connection status
 */
export async function status(): Promise<void> {
  console.log('CmdCtrl Cursor IDE Daemon Status\n');

  // Registration status
  if (!isRegistered()) {
    console.log('Registration: Not registered');
    console.log('\nRun "cmdctrl-cursor-ide register" to register this device.');
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

  // Cursor database status
  const dbExists = cursorDbExists();
  console.log(`\nCursor Database: ${dbExists ? 'Found' : 'Not found'}`);
  if (dbExists) {
    try {
      const db = getCursorDB();
      const composers = db.getComposers();
      console.log(`  Sessions: ${composers.length}`);
    } catch (err) {
      console.log(`  Error reading database: ${(err as Error).message}`);
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
      const composerOpen = await cdp.isComposerOpen();
      console.log(`  Composer panel: ${composerOpen ? 'Open' : 'Closed'}`);
    } else {
      console.log('  Status: Not available');
      console.log('  To enable, start Cursor with:');
      console.log('    /Applications/Cursor.app/Contents/MacOS/Cursor --remote-debugging-port=9222');
    }
  } catch (err) {
    console.log(`  Status: Error - ${(err as Error).message}`);
  }
}
