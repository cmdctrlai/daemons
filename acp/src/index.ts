#!/usr/bin/env node

/**
 * CmdCtrl daemon for any agent that speaks the Agent Client Protocol.
 *
 * Usage:
 *   cmdctrl-acp register --agent "dsh acp"
 *   cmdctrl-acp start
 *   cmdctrl-acp status
 *   cmdctrl-acp stop
 *   cmdctrl-acp unregister
 *
 * A second agent on the same machine is a second instance: add `--instance <name>`.
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
  .name('cmdctrl-acp')
  .description('CmdCtrl daemon for agents that speak the Agent Client Protocol (ACP)')
  .version(DAEMON_VERSION);

const instance = ['-i, --instance <name>', 'Run a separately registered agent (config in ~/.cmdctrl-acp-<name>/)'] as const;

program
  .command('register')
  .description('Register this device with a CmdCtrl server, or change the agent it runs')
  .option('-a, --agent <command>', 'Command that starts the agent in ACP mode, e.g. "dsh acp" (default: the one found on PATH)')
  .option('-s, --server <url>', 'CmdCtrl server URL', 'https://api.cmd-ctrl.ai')
  .option('-n, --name <name>', 'Device name (defaults to <hostname>-<agent>)')
  .option(...instance)
  .action(register);

program
  .command('start')
  .description('Start the daemon and connect to the CmdCtrl server')
  .option('-f, --foreground', 'Run in foreground (default)')
  .option('-d, --detach', 'Run detached from the terminal')
  .option(...instance)
  .action(start);

program
  .command('status')
  .description('Show registration and daemon status')
  .option(...instance)
  .action(status);

program
  .command('stop')
  .description('Stop the running daemon')
  .option(...instance)
  .action(stop);

program
  .command('unregister')
  .description('Remove this device from the CmdCtrl server and clear local config')
  .option(...instance)
  .action(unregister);

program.parse();
