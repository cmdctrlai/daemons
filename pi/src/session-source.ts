/**
 * Where the daemon reads sessions from: pi's own SessionManager for pi, a
 * read-only reader for omp (see `omp-sessions.ts` for why omp files must never
 * reach pi's SessionManager). Chosen once at startup from the agent the daemon drives.
 */

import { piSdk } from './pi-sdk';
import { dirname } from 'path';
import { listOmpSessions, locateOmpSession, readOmpEntries } from './omp-sessions';

/** The part of a session entry the daemon reads, common to pi and omp. */
export interface StoredEntry {
  type: string;
  id: string;
  timestamp: string;
  message?: unknown;
}

/** The part of a session listing the daemon reads, common to pi and omp. */
export interface StoredSession {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  firstMessage: string;
  modified: Date;
  messageCount: number;
}

export interface SessionSource {
  /** Which agent's sessions these are, for messages. */
  readonly agent: string;
  /** Where they live, for messages. */
  readonly location: string;
  /** Sessions, newest first. `cwd` narrows the scan where the agent can. */
  list(cwd?: string): Promise<StoredSession[]>;
  /** One session's entries in file order. Throws if it cannot be read. */
  entries(path: string): Promise<StoredEntry[]>;
  /**
   * For an agent whose session can move to another file while watched: the file
   * session `id` (watched at `path`) now reads from, and the files whose growth
   * can change that, with the sizes they were read at. Absent when sessions never move.
   */
  locate?(id: string, path: string): Promise<{ path: string; copies: Array<{ path: string; size: number }> } | undefined>;
}

export const piSessions: SessionSource = {
  agent: 'pi',
  location: '~/.pi/agent/sessions/',
  async list(cwd) {
    const { SessionManager } = await piSdk();
    return cwd ? SessionManager.list(cwd) : SessionManager.listAll();
  },
  async entries(path) {
    const { SessionManager, CURRENT_SESSION_VERSION, VERSION: PI_SDK_VERSION } = await piSdk();
    const mgr = SessionManager.open(path);
    const header = mgr.getHeader();
    if (header?.version != null && header.version > CURRENT_SESSION_VERSION) {
      throw new Error(
        `pi session ${header.id} was written with file-format v${header.version}; ` +
          `this daemon bundles pi SDK ${PI_SDK_VERSION} (reads up to v${CURRENT_SESSION_VERSION}). ` +
          `Upgrade @cmdctrl/pi.`
      );
    }
    return mgr.getEntries();
  },
};

/**
 * omp buckets sessions by canonical cwd, so a project path reached through a
 * symlink names a different bucket. Scanning every bucket sidesteps that.
 */
export function ompSessions(root: string): SessionSource {
  return {
    agent: 'omp',
    location: root,
    list: () => listOmpSessions(root),
    entries: readOmpEntries,
    locate: (id, path) => locateOmpSession(id, dirname(path)),
  };
}

let active: SessionSource = piSessions;

export function sessionSource(): SessionSource {
  return active;
}

export function useSessionSource(source: SessionSource): void {
  active = source;
}
