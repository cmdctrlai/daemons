/**
 * What slash commands this daemon offers for a Codex project, and how one gets
 * run.
 *
 * Codex has no user-definable `/`-commands. `/init`, `/status` and `/review` are
 * TUI-local built-ins with no app-server method behind them, and there is no
 * `~/.codex/prompts/`. What a user can define is a **skill** – a `SKILL.md` under
 * `<repo>/.agents/skills/`, `~/.agents/skills/` or `~/.codex/skills/` – and the
 * app-server both enumerates skills (`skills/list`) and runs one on request. So a
 * skill is what a Cmd+Ctrl slash command maps to, one for one.
 *
 * ## Why the catalog keeps paths the wire protocol does not carry
 *
 * `turn/start` runs a skill through a `{"type":"skill", name, path}` input
 * element, and codex resolves it by **path** – the name is a label. `path` is not
 * part of `SlashCommandInfo`, and widening that would mean an SDK version bump and
 * a coordinated publish for a value no client has any use for. So the daemon keeps
 * its own name -> path map, per project, filled in when it enumerates and read when
 * a turn starts. Nothing outside this daemon needs to know.
 *
 * The map is per project because scope is: two repos each with their own
 * `.agents/skills/pjm/SKILL.md` both advertise `pjm`, and running the wrong one
 * would work silently and do the wrong thing.
 *
 * ## Nothing is subtracted
 *
 * claude-code and opencode withhold commands whose answer never reaches the app,
 * because their agents advertise TUI-local controls alongside model-dispatched
 * ones. codex does not: `skills/list` returns only skills, every skill is a model
 * turn, and a model turn streams back the way any other does. A skill the user
 * disabled (`enabled: false`) is the one exclusion, and codex has already made
 * that decision for us.
 *
 * `usage_hint` is left unset throughout. Codex skills carry no argument shape,
 * and inventing one would be a guess shown to the user as fact.
 */

import { SlashCommandInfo, SlashCommandSet } from '@cmdctrl/daemon-sdk';
import type { SkillMetadata, SkillsListEntry } from './adapter/protocol-types';

/** A skill the daemon can run, with the path `turn/start` needs. */
export interface SkillCommand {
  name: string;
  description?: string;
  path: string;
}

/** A resolved `/name args` message, ready to become `turn/start` input. */
export interface SkillInvocation {
  name: string;
  path: string;
  /** Everything after the command name. Empty when the user sent the name alone. */
  args: string;
}

/**
 * Split a composer message into a command name and its arguments, or null for
 * ordinary prose. A name may contain a colon – plugin skills are named
 * `plugin:skill` – so only whitespace ends it.
 */
export function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith('/')) return null;
  const match = text.slice(1).match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { name: match[1], args: (match[2] ?? '').trim() };
}

/**
 * Turn codex's raw skill list into the commands worth autocompleting, sorted so
 * the menu order is stable across enumerations.
 */
export function toSkillCommands(skills: SkillMetadata[]): SkillCommand[] {
  const seen = new Set<string>();
  const commands: SkillCommand[] = [];

  for (const skill of skills) {
    const name = skill.name?.trim();
    if (!name || !skill.path || skill.enabled === false || seen.has(name)) continue;
    seen.add(name);

    const command: SkillCommand = { name, path: skill.path };
    const description = skill.description?.trim();
    if (description) command.description = description;
    commands.push(command);
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The skills known for each project the daemon has enumerated.
 *
 * Deliberately not persisted, unlike the claude-code and opencode registries.
 * Both of those learn their set as a side effect of a real turn, so a cold start
 * would leave the composer menu empty until the user happened to send a message.
 * Enumerating codex skills costs one short-lived app-server and no model turn, so
 * the daemon just re-reads the truth at startup rather than trusting a cache that
 * can be wrong.
 */
export class SkillCatalog {
  private byProject = new Map<string, SkillCommand[]>();

  /**
   * Record what codex advertised for a project. Returns true when this changed
   * the stored set, so the caller knows whether a report is worth sending.
   */
  record(project: string, skills: SkillMetadata[]): boolean {
    if (!project) return false;

    const commands = toSkillCommands(skills);
    const previous = this.byProject.get(project);
    if (previous && sameCommands(previous, commands)) return false;

    this.byProject.set(project, commands);
    return true;
  }

  /** Whether this project has been enumerated, whatever it turned up. */
  has(project: string): boolean {
    return this.byProject.has(project);
  }

  /**
   * Forget every project not in this set. Returns true when anything was
   * dropped, so the caller knows to re-report.
   *
   * A project the daemon can no longer see is one whose directory has gone.
   * Keeping its commands would offer a menu built from files that are not there,
   * and a turn for such a session runs in the home directory instead – so the
   * offer would be for one set of skills and the run for another.
   */
  retain(projects: Iterable<string>): boolean {
    const keep = new Set(projects);
    let dropped = false;
    for (const project of [...this.byProject.keys()]) {
      if (!keep.has(project)) {
        this.byProject.delete(project);
        dropped = true;
      }
    }
    return dropped;
  }

  /** Everything known so far, in the protocol's shape – paths stay behind. */
  all(): SlashCommandSet[] {
    return Array.from(this.byProject, ([project, commands]) => ({
      project,
      commands: commands.map(({ name, description }) => {
        const info: SlashCommandInfo = { name };
        if (description) info.description = description;
        return info;
      }),
    }));
  }

  /**
   * The skill a message invokes, or null when it invokes none – ordinary prose,
   * a project we have never enumerated, or a leading slash that is really a path
   * ("/tmp/foo, have a look"). Null means send the text as text.
   */
  resolve(project: string, text: string): SkillInvocation | null {
    const parsed = parseSlashCommand(text);
    if (!parsed) return null;

    const commands = this.byProject.get(project);
    if (!commands) return null;

    // Codex ships skills named Presentations, Spreadsheets and Codex-tab-cleanup,
    // and the composer's menu matches case-insensitively – so a user who types
    // the name in lower case and sends without picking from the menu means the
    // command they can see. Two skills differing only in case would make that a
    // guess, so an ambiguous match resolves to nothing and stays text.
    const command =
      commands.find((c) => c.name === parsed.name) ?? uniqueByCase(commands, parsed.name);
    if (!command) return null;

    return { name: command.name, path: command.path, args: parsed.args };
  }
}

/** The one command matching this name ignoring case, or null if none or several. */
function uniqueByCase(commands: SkillCommand[], name: string): SkillCommand | null {
  const lower = name.toLowerCase();
  const matches = commands.filter((c) => c.name.toLowerCase() === lower);
  return matches.length === 1 ? matches[0] : null;
}

/** What the refresher needs from the adapter. */
export interface SkillLister {
  listSkills(cwds: string[]): Promise<SkillsListEntry[]>;
}

/**
 * Keeps the catalog current.
 *
 * Enumeration spawns a codex app-server, so it happens on demand rather than on
 * a timer: once at startup, once the first time a turn runs in a project nobody
 * has enumerated, and whenever codex says a skill file changed.
 */
export class SkillRefresher {
  /**
   * Enumerations run one at a time, queued rather than collapsed. Collapsing
   * would be cheaper and wrong: a caller asking about a project the in-flight
   * run never looked at would be told it was covered, and the turn waiting on
   * that answer would go out as text.
   */
  private queue: Promise<unknown> = Promise.resolve();

  /**
   * Projects `ensureProject` has already spent an enumeration on, whether or not
   * it produced anything.
   *
   * Without this a codex that cannot answer – missing binary, a version with no
   * `skills/list`, an app-server that accepts the request and never replies –
   * makes every single message pay the attempt again, up to the request timeout,
   * for the life of the daemon. One attempt per project is the cost this feature
   * is meant to have; a periodic full refresh is what recovers from a bad day.
   */
  private attempted = new Set<string>();

  constructor(
    private readonly catalog: SkillCatalog,
    private readonly lister: SkillLister,
    /** The projects worth enumerating – existing directories, no duplicates. */
    private readonly discoverProjects: () => string[],
    private readonly onError: (message: string) => void = (m) => console.warn(m)
  ) {}

  /**
   * Re-read every project's skills, plus one the caller names. Returns true when
   * the catalog changed, so the caller knows whether a report is worth sending.
   * Never rejects: a daemon with no composer menu still runs everything else.
   */
  refresh(extraProject?: string): Promise<boolean> {
    const next = this.queue.then(() => this.enumerate(extraProject));
    this.queue = next;
    return next;
  }

  /**
   * Learn a project's skills before its first turn, so a slash command works on
   * the first message rather than the second. Costs one enumeration per project
   * per daemon run; a project already known costs nothing.
   */
  ensureProject(project: string | undefined): Promise<boolean> {
    if (!project || this.catalog.has(project) || this.attempted.has(project)) {
      return Promise.resolve(false);
    }
    // Marked before the await, so two turns starting together in the same new
    // project queue one enumeration between them rather than one each.
    this.attempted.add(project);
    return this.refresh(project);
  }

  private async enumerate(extraProject?: string): Promise<boolean> {
    const projects = new Set(this.discoverProjects());
    if (extraProject) projects.add(extraProject);
    if (projects.size === 0) return false;

    try {
      let changed = false;
      for (const entry of await this.lister.listSkills([...projects])) {
        if (this.catalog.record(entry.cwd, entry.skills)) changed = true;
        for (const err of entry.errors) {
          this.onError(`[Skills] ${err.path}: ${err.message}`);
        }
      }
      // Anything the catalog still holds that codex was not asked about is a
      // project whose directory has gone.
      if (this.catalog.retain(projects)) changed = true;
      return changed;
    } catch (err) {
      this.onError(`Could not enumerate codex skills: ${(err as Error).message}`);
      return false;
    }
  }
}

function sameCommands(a: SkillCommand[], b: SkillCommand[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (cmd, i) =>
        cmd.name === b[i].name &&
        cmd.description === b[i].description &&
        cmd.path === b[i].path
    )
  );
}
