#!/usr/bin/env node

/**
 * CmdCtrl Example Daemon
 *
 * Minimal reference implementation of a CmdCtrl daemon. This daemon demonstrates
 * the complete protocol for integrating any AI agent with CmdCtrl.
 *
 * To build your own daemon, copy this directory and replace the agent logic
 * in src/agent.ts with your actual agent integration.
 *
 * Usage:
 *   cmdctrl-example register -s http://localhost:4000
 *   cmdctrl-example start
 *   cmdctrl-example status
 *   cmdctrl-example stop
 *   cmdctrl-example unregister
 */

import { Command } from 'commander';
import { register } from './commands/register';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';
import { unregister } from './commands/unregister';

const program = new Command();

program
  .name('cmdctrl-example')
  .description('CmdCtrl example daemon - minimal reference implementation')
  .version('1.0.0');

program
  .command('register')
  .description('Register this device with a CmdCtrl server')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'http://localhost:4000')
  .option('-n, --name <name>', 'Device name (defaults to hostname)')
  .action(register);

program
  .command('start')
  .description('Start the daemon and connect to the CmdCtrl server')
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
