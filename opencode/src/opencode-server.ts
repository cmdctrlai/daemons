import { join } from 'path';
import { OpenCodeAdapter } from './adapter/opencode';
import type { EventFeed } from './events';
import { majorVersion } from './opencode-version';
import { OpenCodeV2Adapter } from './v2/adapter';

/** What the daemon drives on an opencode server, whichever major version it runs. */
export type OpenCodeServer = Pick<
  OpenCodeAdapter,
  | 'url' | 'busy' | 'startServer' | 'stopServer' | 'createSession' | 'listSessions' | 'getMessages'
  | 'listCommands' | 'reloadCommands' | 'setCommands' | 'getProjectDirectory'
  | 'send' | 'abort' | 'awaitTurnEnd' | 'turnResult' | 'activity' | 'diff'
  | 'replyPermission' | 'replyQuestion' | 'pendingRequests' | 'sessionDirectory' | 'parentSession'
>;

/**
 * The server for the opencode version installed, and its event feed when it isn't
 * 1.x's. `configDir` holds what the server needs to keep across restarts.
 */
export function serverFor(version: string | undefined, configDir?: string): { server: OpenCodeServer; feed?: EventFeed } {
  if (majorVersion(version) === 2) {
    const v2 = new OpenCodeV2Adapter('', undefined, configDir && join(configDir, 'v2-typed-commands.json'));
    return { server: v2, feed: v2.eventFeed };
  }
  return { server: new OpenCodeAdapter() };
}
