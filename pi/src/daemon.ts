/**
 * The daemon's CLI, runnable under another identity so a package for another
 * pi-family agent can reuse it: `@cmdctrl/omp` calls
 * `runDaemon({ daemonName: 'omp', agentType: 'omp', bin: 'omp', version })`.
 */

import { Command } from 'commander';
import { register } from './commands/register';
import { start } from './commands/start';
import { status } from './commands/status';
import { stop } from './commands/stop';
import { unregister } from './commands/unregister';
import { CLI_NAME, DAEMON_VERSION, useIdentity, type DaemonIdentity } from './context';

export type { DaemonIdentity } from './context';

export function runDaemon(identity: DaemonIdentity, argv: string[] = process.argv): void {
  useIdentity(identity);

  const program = new Command();

  program
    .name(CLI_NAME)
    .description(`CmdCtrl daemon for ${identity.bin}`)
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

  program.parse(argv);
}
