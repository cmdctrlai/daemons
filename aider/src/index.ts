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

// Read version from package.json
let version = '0.0.0';
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));
  version = pkg.version;
} catch {
  // Fallback for development
}

const program = new Command();

program
  .name('cmdctrl-aider')
  .description('Aider daemon - connects your workstation to the CmdCtrl orchestration server via AgentAPI')
  .version(version);

program
  .command('register')
  .description('Register this device with a CmdCtrl server')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'http://localhost:4000')
  .option('-n, --name <name>', 'Device name (defaults to hostname-aider)')
  .action(register);

program
  .command('unregister')
  .description('Remove device registration')
  .action(unregister);

program
  .command('start')
  .description('Start the daemon and connect to the CmdCtrl server')
  .option('-f, --foreground', 'Run in foreground (don\'t daemonize)')
  .action(start);

program
  .command('status')
  .description('Check daemon connection status')
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
