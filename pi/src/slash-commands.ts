/**
 * What slash commands this daemon is willing to have autocompleted in the app's
 * composer, per project directory.
 *
 * pi computes the set for us – see `pi-commands.ts`. We take that list and only
 * subtract from it.
 *
 * ## How a command actually runs, and why that decides what we offer
 *
 * The daemon runs every turn as `pi --mode json -p "<text>"`. Print mode hands the
 * text to `AgentSession.prompt()`, which is the same entry point the TUI uses, so
 * a prompt template and a skill both expand and reach the model exactly as they
 * would interactively. The reply comes back as an ordinary assistant message and
 * the client sees it. That is the whole test: does an invocation end in assistant
 * text.
 *
 * pi's built-in TUI commands never reach this list. `get_commands` omits them by
 * construction and pi's own rpc docs say why – they "are handled only in
 * interactive mode and would not execute if sent via prompt". Confirmed live: an
 * enumeration of a project with a template, a skill and four extension commands
 * returned exactly those six and no `/model`, `/compact` or `/quit`.
 *
 * ## Withheld
 *
 * | Source | Observed behaviour down `pi --mode json -p`, pi 0.67.1 |
 * |--------|--------------------------------------------------------|
 * | `extension` | **Withheld.** An extension command runs its own handler instead of prompting, and the three ways a handler can speak are not equally visible. `ctx.ui.notify(...)` is a TUI call: a probe command using it exited 0 and emitted nothing but the session header – no assistant text, and pi never even created a session file, so the CmdCtrl session it opened could not afterwards be resumed. `pi.sendMessage(...)` writes a `role: "custom"` entry, which no CmdCtrl client renders and neither the reader nor the watcher collects; that probe was silent in the same way. Only a handler that drives a real turn via `pi.sendUserMessage(...)` **and** waits correctly for it produced assistant text – and a probe that awaited `ctx.waitForIdle()` without first letting the prompt start raced the print-mode exit and produced nothing. Two of four probes were silent, one was silent through a plausible authoring mistake, and nothing in `get_commands` distinguishes them. Extensions are also arbitrary user code, so there is no per-name list to build. Rendering `role: "custom"` entries as agent-visible content is what would let this class come back. |
 *
 * ## Offered
 *
 * | Source | Observed behaviour |
 * |--------|--------------------|
 * | `prompt` | Works. `/reviewdiff Widget` against a project-local `.pi/prompts/reviewdiff.md` expanded, ran a turn and returned assistant text. The stored user message is the expansion, so `CommandCollapser` puts the invocation back. |
 * | `skill` | Works. `/skill:probeskill please` expanded into pi's `<skill …>` block, ran a turn (the model read the SKILL.md and answered) and returned assistant text. The block is likewise collapsed back to `/skill:probeskill please`. |
 *
 * Templates and skills the user adds later flow through untouched. That is the
 * point of subtracting rather than listing: they are the whole set and we cannot
 * know their names.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { SlashCommandInfo, SlashCommandSet } from '@cmdctrl/daemon-sdk';
import type { PiCommand, PiCommandSource } from './pi-commands';

/** Command sources that do not survive the daemon's print-mode path. */
const WITHHELD_SOURCES = new Set<PiCommandSource>(['extension']);

/**
 * Turn pi's raw command list into the commands worth autocompleting, sorted so
 * the menu order is stable across runs. pi supplies a description for each, so
 * we carry it straight through.
 */
export function filterSlashCommands(commands: PiCommand[]): SlashCommandInfo[] {
  const seen = new Set<string>();
  const result: SlashCommandInfo[] = [];

  for (const command of commands) {
    const name = command.name?.trim();
    if (!name || name.startsWith('_') || seen.has(name)) continue;
    if (WITHHELD_SOURCES.has(command.source)) continue;
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
 * Enumerating costs a pi process, so the daemon does it as a side effect of real
 * work rather than polling. Keeping the set across restarts matters more here
 * than elsewhere: otherwise every daemon update would take the menu away until
 * the next message. Pass a `cachePath` to persist it; omit it for an in-memory
 * registry.
 */
export class SlashCommandRegistry {
  private byProject = new Map<string, SlashCommandInfo[]>();

  constructor(private readonly cachePath?: string) {
    this.load();
  }

  /**
   * Record what pi advertised for a project. Returns true when this changed the
   * stored set, so the caller knows whether a report is worth sending.
   */
  record(project: string, commands: PiCommand[]): boolean {
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
