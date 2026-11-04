#!/usr/bin/env node

/**
 * CmdCtrl daemon for the pi coding agent.
 *
 * Usage:
 *   cmdctrl-pi register
 *   cmdctrl-pi start
 *   cmdctrl-pi status
 *   cmdctrl-pi stop
 *   cmdctrl-pi unregister
 */

import { PI_IDENTITY } from './context';
import { runDaemon } from './daemon';

runDaemon(PI_IDENTITY);
