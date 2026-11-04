/**
 * What commands pi will accept for a project directory.
 *
 * The set is not ours to invent. pi already computes it: `pi --mode rpc` answers
 * `get_commands` with the extension commands, prompt templates and skills that
 * resolve for the directory it was started in. Its own docs are explicit that the
 * list is "available for invocation via prompt" and that the built-in TUI commands
 * (`/model`, `/quit`, `/compact`, …) are deliberately excluded because they "would
 * not execute if sent via prompt" – which is exactly the line the daemon needs.
 *
 * We start a throwaway rpc process per project rather than reusing one: the set is
 * a property of the working directory, and pi resolves it at startup. `--no-session`
 * keeps the probe out of `pi --resume`, and `--offline` keeps it off the network so
 * a flaky connection cannot stall a composer menu. Measured at ~330ms per project
 * against pi 0.67.1.
 *
 * omp asks the same question in its own dialect: `get_available_commands`, a wider
 * `source` enum, no `sourceInfo`, and no `--offline` flag. See `DIALECTS`.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import type { AgentFlavor } from './agent-flavor';
import { findOmpTemplate } from './omp-commands';
import { PI_BIN } from './context';
import { piSdk } from './pi-sdk';

/** Where pi found a command. Mirrors pi's own `SlashCommandSource`. */
export type PiCommandSource = 'extension' | 'prompt' | 'skill';

export interface PiCommand {
  /** Name as typed, without the leading slash. Skills arrive as `skill:<name>`. */
  name: string;
  description?: string;
  source: PiCommandSource;
  /**
   * For a prompt template, the body pi will substitute arguments into. pi stores
   * the *expansion* as the user's message with no record of its origin, so the
   * body is what lets `CommandCollapser` recognise an invocation after the fact.
   */
  template?: string;
  /** omp appends the arguments after a template with no placeholder; pi drops them. */
  argsAppended?: boolean;
}

/** How long to wait for pi to answer before giving up on the menu for a project. */
const PROBE_TIMEOUT_MS = 20_000;

interface Dialect {
  args: string[];
  /** The rpc command that lists commands; its response carries the same name. */
  request: string;
  /** Map the agent's `source` onto ours, or drop the command. */
  source(raw: string | undefined): PiCommandSource | undefined;
  /** For a prompt the catalog gives no path for: the template the agent would expand. */
  findTemplate?(cwd: string, name: string): Promise<string | undefined>;
  /** The agent appends the arguments to a template with no placeholder (pi drops them). */
  argsAppended?: boolean;
}

const DIALECTS: Record<AgentFlavor, Dialect> = {
  pi: {
    args: ['--mode', 'rpc', '--no-session', '--offline'],
    request: 'get_commands',
    source: (raw) => (raw === 'extension' || raw === 'prompt' || raw === 'skill' ? raw : undefined),
  },
  // Measured against omp 18.15.0 down `omp --mode json -p`: a markdown `file`
  // command expands into a model turn like a pi prompt template; `custom` (TypeScript
  // and MCP) and `extension` commands run handler code that may never speak, like pi
  // extensions; a `builtin` or a `/skill:` command is not expanded in print mode at
  // all and reaches the model as literal text.
  omp: {
    args: ['--mode', 'rpc', '--no-session'],
    request: 'get_available_commands',
    source: (raw) => {
      switch (raw) {
        case 'file': return 'prompt';
        case 'custom':
        case 'extension': return 'extension';
        default: return undefined;
      }
    },
    // omp's catalog carries no path, so look where omp itself reads markdown
    // commands (see omp-commands.ts). A command with no file there – the bundled
    // `/init` – keeps showing its expansion.
    findTemplate: (cwd, name) => findOmpTemplate(cwd, name),
    argsAppended: true,
  },
};

export interface RpcCommand {
  name?: string;
  description?: string;
  source?: string;
  sourceInfo?: { path?: string };
}

/**
 * Ask pi which commands a project accepts.
 *
 * Throws if pi cannot be started or does not answer; the caller treats that as
 * "no menu for this project" rather than a daemon failure.
 */
export async function listCommands(cwd: string, flavor: AgentFlavor = 'pi'): Promise<PiCommand[]> {
  // A session outlives its project directory – a deleted worktree, an unmounted
  // volume. spawn reports a missing cwd as ENOENT on the binary, which reads as
  // "pi is not installed" and sends anyone debugging it the wrong way.
  if (!existsSync(cwd)) return [];

  const dialect = DIALECTS[flavor];
  const raw = await probe(cwd, flavor, dialect);
  const commands: PiCommand[] = [];

  for (const entry of raw) {
    const name = entry.name?.trim();
    const source = dialect.source(entry.source);
    if (!name || !source) continue;

    const command: PiCommand = { name, source };
    const description = entry.description?.trim();
    if (description) command.description = description;
    const path = entry.sourceInfo?.path;
    if (source === 'prompt' && path) {
      const template = await readTemplate(path);
      if (template) command.template = template;
    } else if (source === 'prompt' && dialect.findTemplate) {
      const template = await dialect.findTemplate(cwd, name);
      if (template) command.template = template;
    }
    if (source === 'prompt' && dialect.argsAppended) command.argsAppended = true;
    commands.push(command);
  }

  return commands;
}

/**
 * The template body pi would expand, read the same way pi reads it: the file
 * minus its frontmatter. Returns undefined if the file has since moved – a
 * command we cannot collapse is still a command we can offer.
 */
async function readTemplate(path: string): Promise<string | undefined> {
  try {
    const { parseFrontmatter } = await piSdk();
    const contents = await readFile(path, 'utf-8');
    return parseFrontmatter(contents).body;
  } catch {
    return undefined;
  }
}

function probe(cwd: string, flavor: AgentFlavor, dialect: Dialect): Promise<RpcCommand[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(PI_BIN, dialect.args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (err: Error | null, commands?: RpcCommand[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (err) reject(err); else resolve(commands ?? []);
    };

    const timer = setTimeout(
      () => finish(new Error(`${flavor} did not answer ${dialect.request} within ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    );
    timer.unref();

    child.on('error', (err) => finish(new Error(`could not run "${PI_BIN}": ${err.message}`)));

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8192) stderr = stderr.slice(-8192);
    });

    // pi's rpc framing is strict JSONL on LF. Node's readline also splits on
    // U+2028/U+2029, which are legal inside a JSON string, so split by hand.
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      let newline = stdout.indexOf('\n');
      while (newline !== -1) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        stdout = stdout.slice(newline + 1);
        const commands = commandsFromLine(line, dialect.request);
        if (commands) finish(null, commands);
        newline = stdout.indexOf('\n');
      }
    });

    child.on('close', (code) => {
      const tail = stderr.trim().split('\n').slice(-3).join('\n');
      finish(new Error(`${flavor} rpc exited with code ${code} before answering${tail ? `: ${tail}` : ''}`));
    });

    child.stdin.write(JSON.stringify({ type: dialect.request, id: 'cmdctrl' }) + '\n');
    child.stdin.end();
  });
}

export function commandsFromLine(line: string, request: string): RpcCommand[] | null {
  if (!line.trim()) return null;
  let parsed: any;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (parsed?.type !== 'response' || parsed.command !== request) return null;
  if (!parsed.success) return [];
  return Array.isArray(parsed.data?.commands) ? parsed.data.commands : [];
}
