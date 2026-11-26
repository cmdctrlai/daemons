/**
 * What slash commands this daemon is willing to have autocompleted in the app's
 * composer, per project directory.
 *
 * The set is not ours to invent. opencode's server already computes it and
 * publishes it at `GET /command` – its built-ins, the user's skills, and any MCP
 * prompts, each resolved for the directory the server runs in. We take that list
 * verbatim and only subtract from it.
 *
 * ## How the command actually runs, and why that decides what we offer
 *
 * Every entry `GET /command` returns is a prompt template. When the user picks one,
 * the composer sends its text ("/review", "/init foo") and the adapter routes it to
 * `POST /session/{id}/command`, which expands the template and dispatches it to the
 * model – so the reply streams back as an ordinary assistant message. (The plain
 * message endpoint does not expand commands: it would hand "/review" to the model as
 * literal text and get an improvised answer, never the command. Hence the routing in
 * the adapter.)
 *
 * That single dispatch path is why the withhold list is empty. opencode's `/command`
 * carries only model-dispatched templates; it does not enumerate the TUI's own
 * controls (clear, help, models, themes, sessions, …) – those live under `/tui/*`
 * and never reach this list. So there is no command here that confirms success while
 * silently doing nothing, and none whose answer is written where the client can't see
 * it – the two failure modes that force claude-code to subtract. If opencode ever adds
 * a command that misbehaves down the `/command` path, name it in WITHHELD with the
 * transcript that proved it, exactly as claude-code does.
 *
 * ## Verified against opencode 1.2.20 (`GET /command`, `POST /session/{id}/command`)
 *
 * /review (source=command) dispatched to the model and streamed an assistant message
 * back down the `/command` path (verified live). /init is the same template mechanism.
 * The skills the endpoint surfaces are the user's own installed skills; like
 * claude-code's custom commands they are offered by name and description and not
 * probed – running one is a genuine agentic task, not ours to withhold.
 *
 * Anything opencode adds in a future version flows through untouched. That is the
 * point of subtracting rather than listing: the user's own skills are the majority of
 * the set and we can't know their names.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { SlashCommandInfo, SlashCommandSet } from '@cmdctrl/daemon-sdk';
import type { OpenCodeCommand } from './adapter/opencode';
import type { OpenCodeServer } from './opencode-server';

/** How often commands are re-read, so one the user adds appears without a restart. */
export const COMMAND_REFRESH_MS = 60_000;

/**
 * A project with a session this recent has its commands reloaded on every refresh;
 * older ones keep their last set. Reloading restarts the project's MCP servers, so
 * it is spent only where the user is working.
 */
const RECENT_PROJECT_MS = 24 * 60 * 60 * 1000;

/**
 * Commands the daemon runs itself. opencode's terminal compacts a session on
 * `/compact`, but its `GET /command` doesn't list it; the daemon calls opencode's
 * summarize instead.
 */
export const DAEMON_COMMANDS: OpenCodeCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context' },
];

/** Commands opencode advertises that do not survive the daemon path. Empty today. */
const WITHHELD = new Set<string>();

/**
 * Turn opencode's raw command list into the commands worth autocompleting, sorted
 * so the menu order is stable across runs. opencode supplies a description for each,
 * so – unlike claude-code – we carry it straight through.
 */
export function filterSlashCommands(commands: OpenCodeCommand[]): SlashCommandInfo[] {
  const seen = new Set<string>();
  const result: SlashCommandInfo[] = [];

  for (const command of commands) {
    const name = command.name?.trim();
    if (!name || name.startsWith('_') || WITHHELD.has(name) || seen.has(name)) continue;
    seen.add(name);

    const info: SlashCommandInfo = { name };
    const description = command.description?.trim();
    if (description) info.description = description;
    result.push(info);
  }

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remembers the command set for each project the daemon has seen.
 *
 * CommandRefresher re-reads the sets on a timer. Keeping them across restarts still
 * matters: a project the daemon has not reached yet would otherwise have no menu
 * after every daemon update. Pass a `cachePath` to persist it; omit it for an
 * in-memory registry.
 */
export class SlashCommandRegistry {
  private byProject = new Map<string, SlashCommandInfo[]>();

  constructor(private readonly cachePath?: string) {
    this.load();
  }

  /**
   * Record what opencode advertised for a project. Returns true when this changed
   * the stored set, so the caller knows whether a report is worth sending.
   */
  record(project: string, commands: OpenCodeCommand[]): boolean {
    if (!project || commands.length === 0) return false;

    const filtered = filterSlashCommands(commands);
    const previous = this.byProject.get(project);
    if (previous && sameCommands(previous, filtered)) return false;

    this.byProject.set(project, filtered);
    this.save();
    return true;
  }

  /** Everything known so far, in the protocol's shape. */
  all(): SlashCommandSet[] {
    return Array.from(this.byProject, ([project, commands]) => ({ project, commands }));
  }

  private load(): void {
    if (!this.cachePath) return;
    try {
      const sets = JSON.parse(readFileSync(this.cachePath, 'utf-8')) as SlashCommandSet[];
      for (const set of sets) {
        if (set?.project && Array.isArray(set.commands)) {
          this.byProject.set(set.project, set.commands);
        }
      }
    } catch {
      // No cache yet, or it was written by an incompatible version. Either way the
      // next run of any project rebuilds it – never fail startup over a cache.
    }
  }

  private save(): void {
    if (!this.cachePath) return;
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true });
      writeFileSync(this.cachePath, JSON.stringify(this.all()), 'utf-8');
    } catch (err) {
      console.error('Failed to cache slash commands:', (err as Error).message);
    }
  }
}

/**
 * Keeps the registry and the adapter's command routing in step with opencode.
 *
 * opencode resolves commands per directory: the global built-ins and user skills
 * merged with whatever that project defines. A session only ever sees its own
 * project's set, so each distinct session directory is asked separately and its
 * set recorded under that project – the API looks the set up by the session's
 * project. Resolving only the server's own directory would key every command
 * under wherever the daemon happens to run and match no session.
 */
export class CommandRefresher {
  /** Each project's full commands, templates included, for the adapter's routing. */
  private byProject = new Map<string, OpenCodeCommand[]>();

  constructor(
    private readonly adapter: OpenCodeServer,
    private readonly registry: SlashCommandRegistry,
  ) {}

  /**
   * Re-read every project's commands. Returns true when a set changed, so the
   * caller knows a report is worth sending. Non-fatal – the daemon runs fine
   * without a composer menu.
   */
  async refresh(now = Date.now()): Promise<boolean> {
    try {
      // Every session, including ones the app started – their projects need menus too.
      const projects = new Map<string, boolean>();
      for (const session of await this.adapter.listSessions(new Set())) {
        if (!session.project) continue;
        const recent = now - Date.parse(session.last_activity) < RECENT_PROJECT_MS;
        projects.set(session.project, projects.get(session.project) || recent);
      }
      // The server's own directory covers a daemon with no sessions yet.
      projects.set(await this.adapter.getProjectDirectory(), true);

      let changed = false;
      for (const [project, reload] of projects) {
        if (!project) continue;
        const commands = reload
          ? await this.adapter.reloadCommands(project)
          : await this.adapter.listCommands(project);
        // A turn is running; this project keeps its set until the next refresh.
        if (!commands) continue;
        this.byProject.set(project, commands);
        if (this.registry.record(project, [...commands, ...DAEMON_COMMANDS])) changed = true;
      }

      // Every project's commands, so a leading-slash message from any session
      // routes to /command and any project's expansion can be recognised again.
      const known = new Map<string, OpenCodeCommand>();
      for (const commands of this.byProject.values()) {
        for (const command of commands) known.set(command.name, command);
      }
      this.adapter.setCommands([...known.values()]);
      return changed;
    } catch (err) {
      console.warn('Could not enumerate opencode slash commands:', (err as Error).message);
      return false;
    }
  }
}

function sameCommands(a: SlashCommandInfo[], b: SlashCommandInfo[]): boolean {
  return a.length === b.length
    && a.every((cmd, i) => cmd.name === b[i].name && cmd.description === b[i].description);
}
