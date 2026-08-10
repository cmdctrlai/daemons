/**
 * What slash commands this daemon is willing to have autocompleted in the app's
 * composer, per project directory.
 *
 * The set is not ours to invent. The Claude CLI already computes it – built-ins,
 * plus the user's `~/.claude/commands` and skills, plus that project's
 * `.claude/skills` and plugins – and publishes it as `slash_commands` on the
 * `system`/`init` stream event of every run. We take that list verbatim and only
 * subtract from it.
 *
 * ## Why anything is subtracted
 *
 * The daemon spawns a fresh one-shot CLI process per turn (`claude -p … --resume`)
 * and forwards the message text unchanged – nothing intercepts a leading slash. So
 * whether a command "works" is purely a question of how the CLI behaves when it
 * receives that text non-interactively, and a command that confirms success then
 * silently does nothing is worse than one we never offered. Each withheld command
 * below was run down exactly that path before being withheld.
 *
 * ## Verified against CLI 2.1.222 (`claude -p "<cmd>" --output-format stream-json
 * --verbose --permission-mode acceptEdits`, the adapter's own invocation)
 *
 * Withheld:
 *
 *   /clear     Forks a brand-new native session id instead of clearing the tracked
 *              one. The server's updateNativeSessionID only migrates sessions still
 *              PENDING, so the next resume keeps the pre-clear id and history –
 *              nothing visibly clears and the fork is an orphaned file on disk that
 *              Cmd+Ctrl never tracks.
 *   /model     Replies "Set model to X for this session only" – a false confirmation.
 *              The setting lives in the one-shot process and is gone by the next turn.
 *   /color     Replies "Session color set to: purple". Same class as /model: nothing
 *              is written anywhere, and the app has no session color to show anyway.
 *   /effort    Replies "Not applied: the launch-effort pin holds effort at <level>
 *              this session." Never takes effect down this path.
 *   /fast      Replies "Fast mode unavailable: Fast mode is not available in the
 *              Agent SDK."
 *   _-prefixed Internal plumbing the CLI advertises but does not document
 *              (e.g. __remote-workflow).
 *
 * Verified working, and therefore offered: /compact (real compaction, session id
 * preserved), /rename (persists the CLI slug the app surfaces as cli_user_title),
 * /context, /mcp, /usage, /recap, /agents, /insights, /goal, /autocompact (writes
 * autoCompactWindow to settings.json), and explicit custom-skill invocation
 * (`/skill-name`), which dispatches as a genuine multi-turn agentic task – including
 * skills marked `disable-model-invocation`, since that flag only blocks autonomous
 * use, not explicit invocation.
 *
 * Anything the CLI adds in a future version flows through untouched. That is the
 * point of subtracting rather than listing: the user's own commands are the majority
 * of the set and we can't know their names.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { SlashCommandInfo, SlashCommandSet } from '@cmdctrl/daemon-sdk';

/** Commands the CLI advertises that do not survive the one-shot daemon path. */
const WITHHELD = new Set(['clear', 'model', 'color', 'effort', 'fast']);

/**
 * Descriptions for the built-ins worth explaining. Custom commands are offered by
 * name alone – the init event carries no descriptions, and guessing at one for a
 * user's own skill would be worse than showing nothing.
 */
const DESCRIPTIONS: Record<string, { description: string; usage_hint?: string }> = {
  compact: { description: 'Summarize the conversation to free up context' },
  context: { description: 'Show context and token usage' },
  rename: { description: 'Rename this session', usage_hint: '<title>' },
  mcp: { description: 'MCP server status', usage_hint: '[reconnect|enable|disable]' },
  usage: { description: 'Show plan usage and limits' },
  recap: { description: 'Recap the conversation so far' },
  insights: { description: 'Generate a usage insights report' },
  goal: { description: 'Set a goal for the session', usage_hint: '<condition>' },
  autocompact: { description: 'Set the auto-compact window', usage_hint: '<auto|tokens>' },
  init: { description: 'Create a CLAUDE.md for this project' },
};

/**
 * Turn the CLI's raw name list into the commands worth autocompleting, sorted so
 * the menu order is stable across runs.
 */
export function filterSlashCommands(names: string[]): SlashCommandInfo[] {
  const seen = new Set<string>();
  const commands: SlashCommandInfo[] = [];

  for (const raw of names) {
    const name = raw.trim();
    if (!name || name.startsWith('_') || WITHHELD.has(name) || seen.has(name)) continue;
    seen.add(name);
    commands.push({ name, ...DESCRIPTIONS[name] });
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Remembers the command set for each project the daemon has seen a run in.
 *
 * Nothing here probes the CLI: a probe run costs a model turn and leaves an
 * orphaned session file behind, so the set is learned only as a side effect of
 * real work. That makes the set worth keeping across restarts – otherwise every
 * daemon update would take the menu away until the user happened to send another
 * message. Pass a `cachePath` to persist it; omit it for an in-memory registry.
 */
export class SlashCommandRegistry {
  private byProject = new Map<string, SlashCommandInfo[]>();

  constructor(private readonly cachePath?: string) {
    this.load();
  }

  /**
   * Record what the CLI advertised for a project. Returns true when this changed
   * the stored set, so the caller knows whether a report is worth sending.
   */
  record(project: string, names: string[]): boolean {
    if (!project || names.length === 0) return false;

    const commands = filterSlashCommands(names);
    const previous = this.byProject.get(project);
    if (previous && sameCommands(previous, commands)) return false;

    this.byProject.set(project, commands);
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
  return a.length === b.length && a.every((cmd, i) => cmd.name === b[i].name);
}
