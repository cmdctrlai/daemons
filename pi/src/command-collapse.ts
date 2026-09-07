/**
 * Turn an expanded pi command back into the `/name args` the user typed.
 *
 * pi expands a command before it stores anything. A prompt template becomes a
 * plain user message with no record of which template produced it; a skill becomes
 * a `<skill …>` block wrapping the whole SKILL.md body. Both are machinery, and
 * both are written to the session file under `role: "user"`, so a transcript – and
 * the session's title and last-message preview, which are drawn from the same text –
 * otherwise shows a wall of prompt where the user typed one word.
 *
 * Recovering the invocation from the stored text rather than from what the daemon
 * happened to send is deliberate: the same session can be driven from the terminal,
 * and the app should render those turns identically.
 */

/** Everything pi's `substituteArgs` will replace: `$1`, `$@`, `$ARGUMENTS`, `${@:N}`, `${@:N:L}`. */
const PLACEHOLDER = /\$\{@:\d+(?::\d+)?\}|\$ARGUMENTS|\$@|\$\d+/g;

/**
 * pi's skill expansion, per `parseSkillBlock` in pi 0.67. The block is emitted
 * verbatim by `AgentSession`, so matching its shape is as reliable as an explicit
 * marker would be.
 */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="[^"]+">\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]+))?$/;

/**
 * How much fixed template text must match before an expansion is attributed to a
 * command. Templates run to paragraphs; anything this short is more likely to be
 * something the user genuinely typed.
 */
const MIN_TEMPLATE_TEXT = 24;

export interface CollapsibleCommand {
  name: string;
  /** The template body. Commands without one (skills, extensions) are ignored here. */
  template?: string;
}

interface CompiledTemplate {
  name: string;
  /** Fixed text before the first placeholder. */
  prefix: string;
  /** Fixed text after the only placeholder. Empty unless mode is `args`. */
  suffix: string;
  /** exact: no placeholder; args: one, so they can be read back; prefix: several. */
  mode: 'exact' | 'args' | 'prefix';
}

export class CommandCollapser {
  private templates: CompiledTemplate[] = [];

  /**
   * Record the templates to recognise, across every project enumerated. Commands
   * whose fixed text is too short to tell from prose are dropped rather than
   * risking a false match.
   */
  setCommands(commands: CollapsibleCommand[]): void {
    const compiled: CompiledTemplate[] = [];

    for (const command of commands) {
      const template = command.template?.trim();
      if (!template) continue;

      const markers = [...template.matchAll(PLACEHOLDER)];
      if (markers.length === 0) {
        // pi substitutes nothing and appends nothing, so the expansion is the
        // template itself – an exact comparison, safe at any length.
        compiled.push({ name: command.name, prefix: template, suffix: '', mode: 'exact' });
        continue;
      }

      const first = markers[0];
      const prefix = template.slice(0, first.index).trim();

      // One placeholder brackets the arguments, so they can be read back. Several
      // interleave them with the template's own prose, where anything we recovered
      // would be a guess – so the command is named and the arguments left behind.
      const mode = markers.length === 1 ? 'args' : 'prefix';
      const suffix = mode === 'args'
        ? template.slice(first.index + first[0].length).trim()
        : '';

      if (prefix.length + suffix.length < MIN_TEMPLATE_TEXT) continue;
      compiled.push({ name: command.name, prefix, suffix, mode });
    }

    // Longest fixed text first: a specific command wins over one that merely
    // shares its opening lines.
    this.templates = compiled.sort(
      (a, b) => (b.prefix.length + b.suffix.length) - (a.prefix.length + a.suffix.length),
    );
  }

  /**
   * The invocation behind an expanded user message, or null for ordinary prose –
   * which is the overwhelmingly common case.
   */
  collapse(text: string): string | null {
    const trimmed = text.trim();
    if (!trimmed) return null;

    const skill = SKILL_BLOCK.exec(trimmed);
    if (skill) return invocation(`skill:${skill[1]}`, skill[2]?.trim());

    for (const template of this.templates) {
      if (template.mode === 'exact') {
        if (trimmed === template.prefix) return `/${template.name}`;
        continue;
      }
      if (!trimmed.startsWith(template.prefix)) continue;
      if (template.mode === 'prefix') return `/${template.name}`;

      let rest = trimmed.slice(template.prefix.length);
      if (template.suffix) {
        if (!rest.endsWith(template.suffix)) continue;
        rest = rest.slice(0, rest.length - template.suffix.length);
      }
      return invocation(template.name, rest.trim());
    }

    return null;
  }
}

function invocation(name: string, args?: string): string {
  return args ? `/${name} ${args}` : `/${name}`;
}
