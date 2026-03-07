#!/usr/bin/env node

import { Command } from 'commander';
import { register } from './commands/register';
import { unregister } from './commands/unregister';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';

const program = new Command();

program
  .name('cmdctrl-codex-cli')
  .description('CmdCtrl daemon for OpenAI Codex CLI')
  .version('0.1.0');

program
  .command('register')
  .description('Register this device with a CmdCtrl server')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'http://localhost:4000')
  .option('-n, --name <name>', 'Device name (defaults to hostname-codex)')
  .action(register);

program
  .command('unregister')
  .description('Remove local registration data')
  .action(unregister);

program
  .command('start')
  .description('Start the Codex CLI daemon and connect to the CmdCtrl server')
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

program.parse();
