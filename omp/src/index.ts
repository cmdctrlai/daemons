#!/usr/bin/env node

/**
 * CmdCtrl daemon for oh-my-pi (`omp`): `@cmdctrl/pi`'s daemon, registered as
 * its own device so one machine can run pi and omp side by side.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { runDaemon } from '@cmdctrl/pi';

// This package's version, not @cmdctrl/pi's: the server checks it for updates
// and a self-update reinstalls @cmdctrl/omp against it.
const { version } = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

runDaemon({ daemonName: 'omp', agentType: 'omp', bin: 'omp', version });
