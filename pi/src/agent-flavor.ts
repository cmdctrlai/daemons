/**
 * The two members of the pi family the daemon drives: pi itself, or omp.
 *
 * oh-my-pi (`omp`) is a fork that keeps pi's CLI surface – `--mode json -p`,
 * `--session <path>`, the JSON event stream – but stores sessions under its own
 * directory in a file layout pi's SDK refuses to read, and serves a different
 * rpc command catalog. Everything else in the daemon is shared.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export type AgentFlavor = 'pi' | 'omp';

/** omp answers `--version` with `omp/<version>`; pi prints the bare version. */
export function flavorFromVersion(output: string): AgentFlavor {
  return /^omp\b/.test(output.trim()) ? 'omp' : 'pi';
}

/** omp's profile name rule; an invalid name falls back to the default profile, as omp's resolver does. */
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
function profileName(raw: string | undefined): string | undefined {
  const name = raw?.trim();
  if (!name || name === 'default' || name.endsWith('.') || !PROFILE_NAME_RE.test(name)) return undefined;
  return name;
}

/**
 * Where omp writes sessions, resolved the way omp 18.x's `DirResolver` does
 * (`packages/utils/src/dirs.ts`, `getSessionsDir`):
 *
 * - The profile is `OMP_PROFILE`, else `PI_PROFILE`; a profile lives under
 *   `~/.omp/profiles/<name>/agent` and ignores `PI_CODING_AGENT_DIR`.
 * - Without a profile, `PI_CODING_AGENT_DIR` replaces the agent dir, unless it is
 *   just the agent dir of the `PI_PROFILE` that an empty `OMP_PROFILE` overrode.
 * - `PI_CONFIG_DIR` renames the `.omp` root under home.
 * - On Linux and macOS, when the agent dir is the default one and
 *   `$XDG_DATA_HOME/omp` exists (`omp config init-xdg` made it) – for a profile,
 *   `$XDG_DATA_HOME/omp/profiles/<name>` – sessions live there instead, with the
 *   `agent/` level dropped.
 */
/**
 * omp's agent directory – where its config, including user commands, lives.
 * XDG moves only data (sessions), so this is the agent dir before XDG.
 */
export function ompAgentDir(env: NodeJS.ProcessEnv = process.env, home: string = env.HOME || homedir()): string {
  return ompDirs(env, home).agentDir;
}

function ompDirs(env: NodeJS.ProcessEnv, home: string): { profile?: string; agentDir: string; defaultAgent: string } {
  const profile = profileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  const baseRoot = join(home, env.PI_CONFIG_DIR || '.omp');
  const configRoot = profile ? join(baseRoot, 'profiles', profile) : baseRoot;
  const defaultAgent = join(configRoot, 'agent');

  const legacyProfile = profileName(env.PI_PROFILE);
  const override = env.PI_CODING_AGENT_DIR;
  const overrideIsProfiles = legacyProfile !== undefined && override === join(baseRoot, 'profiles', legacyProfile, 'agent');
  const agentDir = !profile && override && !overrideIsProfiles ? resolve(override) : defaultAgent;
  return { profile, agentDir, defaultAgent };
}

export function ompSessionsRoot(
  env: NodeJS.ProcessEnv = process.env,
  home: string = env.HOME || homedir(),
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string {
  const { profile, agentDir, defaultAgent } = ompDirs(env, home);
  let dataDir = agentDir;
  if ((platform === 'linux' || platform === 'darwin') && agentDir === defaultAgent && env.XDG_DATA_HOME) {
    const appRoot = join(env.XDG_DATA_HOME, 'omp');
    const xdgRoot = profile ? join(appRoot, 'profiles', profile) : appRoot;
    if (exists(xdgRoot)) dataDir = xdgRoot;
  }
  return join(dataDir, 'sessions');
}
