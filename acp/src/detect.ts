/**
 * ACP agents the daemon knows how to start, found by looking for their binary on PATH.
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseCommandLine } from './command-line';

export interface KnownAgent {
  name: string;
  bin: string;
  command: string;
  /** Its row in the server's agent_types table, which gives the app its name. */
  agentType: string;
  /** Set when another program installs a binary of the same name: the agent is started by full path. */
  shadowed?: boolean;
}

/** Fallback agent type for an agent not in KNOWN_AGENTS. */
export const GENERIC_AGENT_TYPE = 'acp';

/**
 * Keep in step with the list in docs/public/install.sh and the agent_types rows
 * seeded in cmdctrl-api/migrations.
 */
export const KNOWN_AGENTS: KnownAgent[] = [
  { name: 'DeepSeek Harness', bin: 'dsh', command: 'dsh acp', agentType: 'deepseek_harness' },
  { name: 'Qwen Code', bin: 'qwen', command: 'qwen --acp', agentType: 'qwen_code' },
  { name: 'Kimi CLI', bin: 'kimi', command: 'kimi acp', agentType: 'kimi_cli' },
  { name: 'Mistral Vibe', bin: 'vibe-acp', command: 'vibe-acp', agentType: 'mistral_vibe' },
  { name: 'Kiro CLI', bin: 'kiro-cli', command: 'kiro-cli acp', agentType: 'kiro_cli' },
  { name: 'Factory Droid', bin: 'droid', command: 'droid exec --output-format acp', agentType: 'factory_droid' },
  { name: 'Cline', bin: 'cline', command: 'cline --acp', agentType: 'cline' },
  { name: 'Augment (Auggie)', bin: 'auggie', command: 'auggie --acp', agentType: 'auggie' },
  { name: 'Junie', bin: 'junie', command: 'junie --acp=true', agentType: 'junie' },
  { name: 'OpenHands', bin: 'openhands', command: 'openhands acp', agentType: 'openhands' },
  { name: 'Qoder CLI', bin: 'qodercli', command: 'qodercli --acp', agentType: 'qoder_cli' },
  { name: 'goose', bin: 'goose', command: 'goose acp', agentType: 'goose' },
  // The Antigravity IDE puts its own `agy` (a VS Code launcher) on PATH too.
  { name: 'Antigravity', bin: 'agy', command: 'agy acp', agentType: 'antigravity', shadowed: true },
];

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** Whether a file is a VS Code-style editor launcher (`code`, the Antigravity IDE's `agy`), which opens an editor window. */
export function isEditorLauncher(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4096);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return head.subarray(0, n).toString('latin1').includes('VSCODE_IPC_HOOK_CLI');
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Quote a path for an agent command line when it holds a space. */
function quoted(file: string): string {
  return /\s/.test(file) ? `"${file}"` : file;
}

/**
 * The known agents whose binary is on `pathEnv`, in KNOWN_AGENTS order. Editor launchers
 * are skipped, and a shadowed agent's command names the binary by full path so the daemon
 * never starts the launcher instead.
 */
export function detectAgents(
  pathEnv: string | undefined = process.env.PATH,
  executable: (file: string) => boolean = isExecutable,
  launcher: (file: string) => boolean = isEditorLauncher,
): KnownAgent[] {
  const dirs = (pathEnv ?? '').split(path.delimiter).filter(Boolean);
  const found: KnownAgent[] = [];
  for (const agent of KNOWN_AGENTS) {
    const file = dirs.map((dir) => path.join(dir, agent.bin)).find((f) => executable(f) && !launcher(f));
    if (!file) continue;
    found.push(agent.shadowed ? { ...agent, command: agent.command.replace(agent.bin, quoted(file)) } : agent);
  }
  return found;
}

/**
 * The command with a bare shadowed binary (`agy`) replaced by where it resolves now, so a
 * daemon started later with a different PATH order can't reach the launcher instead.
 */
export function pinShadowedBin(
  command: string,
  pathEnv: string | undefined = process.env.PATH,
  executable: (file: string) => boolean = isExecutable,
): string {
  const bin = parseCommandLine(command)[0];
  if (!KNOWN_AGENTS.some((agent) => agent.shadowed && agent.bin === bin)) return command;
  const resolved = resolveBin(bin, pathEnv, executable);
  return resolved ? command.replace(bin, quoted(resolved)) : command;
}

/** Where `bin` resolves: itself when it holds a path separator, else the first executable match on `pathEnv`. */
export function resolveBin(
  bin: string,
  pathEnv: string | undefined = process.env.PATH,
  executable: (file: string) => boolean = isExecutable,
): string | undefined {
  if (bin.includes('/') || bin.includes(path.sep)) return bin;
  return (pathEnv ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin)).find(executable);
}

/** The agent type for an agent command: the known agent it starts, else the generic one. */
export function agentTypeFor(agentCommand: string): string {
  let bin: string;
  try {
    bin = path.basename(parseCommandLine(agentCommand)[0]);
  } catch {
    return GENERIC_AGENT_TYPE; // an unparseable command never matches a known agent
  }
  return KNOWN_AGENTS.find((agent) => agent.bin === bin)?.agentType ?? GENERIC_AGENT_TYPE;
}
