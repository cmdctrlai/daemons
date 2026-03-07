#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { join } from 'path';
import { register } from './commands/register';
import { unregister } from './commands/unregister';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';
import { update } from './commands/update';

let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  version = pkg.version;
} catch {
  // Fallback for development
}

const program = new Command();

program
  .name('cmdctrl-cursor-cli')
  .description('CmdCtrl daemon for Cursor CLI')
  .version(version);

program
  .command('register')
  .description('Register this device with a CmdCtrl server')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'http://localhost:4000')
  .option('-n, --name <name>', 'Device name (defaults to hostname-cursor)')
  .action(register);

program
  .command('unregister')
  .description('Remove local registration data')
  .action(unregister);

program
  .command('start')
  .description('Start the daemon and connect to the CmdCtrl server')
  .option('-f, --foreground', 'Run in foreground (default)')
  .action(start);

program
  .command('status')
  .description('Check daemon registration and connection status')
  .action(status);

program
  .command('stop')
  .description('Stop the running daemon')
  .action(stop);

program
  .command('update')
  .description('Update the daemon to the latest version')
  .action(update);

program.parse();
