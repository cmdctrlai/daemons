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
 * opencode's `GET /command` is a cheap synchronous call, so the daemon re-reads it
 * as a side effect of real work rather than probing. Keeping the set across restarts
 * still matters: otherwise every daemon update would take the menu away until the
 * next message. Pass a `cachePath` to persist it; omit it for an in-memory registry.
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

function sameCommands(a: SlashCommandInfo[], b: SlashCommandInfo[]): boolean {
  return a.length === b.length
    && a.every((cmd, i) => cmd.name === b[i].name && cmd.description === b[i].description);
}
