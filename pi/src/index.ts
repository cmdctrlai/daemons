#!/usr/bin/env node

/**
 * CmdCtrl daemon for the pi coding agent (@mariozechner/pi-coding-agent).
 *
 * Usage:
 *   cmdctrl-pi register
 *   cmdctrl-pi start
 *   cmdctrl-pi status
 *   cmdctrl-pi stop
 *   cmdctrl-pi unregister
 */

import { Command } from 'commander';
import { register } from './commands/register';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';
import { unregister } from './commands/unregister';
import { DAEMON_VERSION } from './context';

const program = new Command();

program
  .name('cmdctrl-pi')
  .description('CmdCtrl daemon for the pi coding agent')
  .version(DAEMON_VERSION);

program
  .command('register')
  .description('Register this device with a CmdCtrl server')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'https://api.cmd-ctrl.ai')
  .option('-n, --name <name>', 'Device name (defaults to hostname)')
  .action(register);

program
  .command('start')
  .description('Start the daemon and connect to the CmdCtrl server')
  .option('-f, --foreground', 'Run in foreground (default)')
  .option('-d, --detach', 'Run detached from the terminal')
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
  .command('unregister')
  .description('Unregister this device from the CmdCtrl server and clear local config')
  .action(unregister);

program.parse();
