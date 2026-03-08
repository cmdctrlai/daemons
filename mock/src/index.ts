#!/usr/bin/env node

import { Command } from 'commander';
import { register } from './commands/register';
import { unregister } from './commands/unregister';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';

const program = new Command();

program
  .name('cmdctrl-mock')
  .description('Mock daemon - simulates AI agent behavior for testing')
  .version('0.1.0');

program
  .command('register')
  .description('Register this mock device with a CmdCtrl server')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'http://localhost:4000')
  .option('-n, --name <name>', 'Device name (defaults to hostname-mock)')
  .action(register);

program
  .command('unregister')
  .description('Remove local registration data')
  .action(unregister);

program
  .command('start')
  .description('Start the mock daemon and connect to the CmdCtrl server')
  .option('-f, --foreground', 'Run in foreground (default)')
  .option('--delay-min <ms>', 'Minimum response delay in ms')
  .option('--delay-max <ms>', 'Maximum response delay in ms')
  .option('--output-lines <count>', 'Number of verbose output lines to generate')
  .option('--ask-probability <0-1>', 'Probability of asking a question (0-1)')
  .option('--error-rate <0-1>', 'Probability of returning an error (0-1)')
  .action(start);

program
  .command('status')
  .description('Check mock daemon status')
  .action(status);

program
  .command('stop')
  .description('Stop the running mock daemon')
  .action(stop);

program.parse();
