import { CommandCollapser, type CollapsibleCommand } from './command-collapse';

/**
 * pi expands a command before it stores anything, so recovering the invocation
 * means matching the stored text back against the template. These cover that
 * recovery, pi's skill block, and – more importantly – that ordinary prose is
 * left alone.
 */
describe('CommandCollapser', () => {
  const positional = 'Review the staged changes in $1 and report only the blocking problems.';

  const arguments_ = [
    'You are a release-notes writer. Work only from the input below.',
    '',
    '$ARGUMENTS',
  ].join('\n');

  const at = 'Summarise the following for a reader in a hurry, in three bullets: $@';

  const repeated = [
    'You are a code reviewer for this repository, and you are thorough.',
    '',
    'Input: $ARGUMENTS',
    '',
    'Run `git show $ARGUMENTS` when the input names a commit.',
  ].join('\n');

  const noArgs = 'Create or update AGENTS.md for this repository, compactly.';

  const slice = 'Compare the first two inputs, ${@:1:2}, against the rest, ${@:3}.';

  function collapserWith(commands: CollapsibleCommand[]): CommandCollapser {
    const collapser = new CommandCollapser();
    collapser.setCommands(commands);
    return collapser;
  }

  const collapser = collapserWith([
    { name: 'review', template: positional },
    { name: 'notes', template: arguments_ },
    { name: 'brief', template: at },
    { name: 'deep-review', template: repeated },
    { name: 'init', template: noArgs },
    { name: 'compare', template: slice },
    { name: 'skill:search' },
    { name: 'no-template' },
  ]);

  const skillBlock = (name: string, body: string, trailing?: string) =>
    `<skill name="${name}" location="/home/u/.pi/agent/skills/${name}/SKILL.md">\n`
    + `References are relative to /home/u/.pi/agent/skills/${name}.\n\n${body}\n</skill>`
    + (trailing ? `\n\n${trailing}` : '');

  const cases: Array<{ name: string; text: string; want: string | null }> = [
    {
      name: 'a $1 expansion recovers the command and the argument',
      text: positional.replace('$1', 'cmdctrl-api'),
      want: '/review cmdctrl-api',
    },
    {
      name: 'an expansion with empty arguments recovers just the command',
      text: positional.replace('$1', ''),
      want: '/review',
    },
    {
      name: 'a trailing $ARGUMENTS expansion recovers the arguments',
      text: arguments_.replace('$ARGUMENTS', 'v1.2.0 through v1.3.0'),
      want: '/notes v1.2.0 through v1.3.0',
    },
    {
      name: 'a $@ expansion recovers the arguments',
      text: at.replace('$@', 'the migration plan'),
      want: '/brief the migration plan',
    },
    {
      name: 'a template with no placeholder matches exactly',
      text: noArgs,
      want: '/init',
    },
    {
      // pi substitutes nothing and appends nothing, so an argument the template
      // has nowhere to put simply never reaches the expansion.
      name: 'text beyond a placeholderless template is not that command',
      text: `${noArgs}\n\nfocus on the build steps`,
      want: null,
    },
    {
      name: 'a repeated placeholder still identifies the command',
      text: repeated.split('$ARGUMENTS').join('abc123'),
      want: '/deep-review',
    },
    {
      name: 'a bash-style slice still identifies the command',
      text: slice.replace('${@:1:2}', 'a b').replace('${@:3}', 'c d'),
      want: '/compare',
    },
    {
      name: 'a skill block collapses to the skill invocation',
      text: skillBlock('release-notes', 'Draft the notes from the git log.'),
      want: '/skill:release-notes',
    },
    {
      name: 'a skill block carries the arguments the user typed',
      text: skillBlock('release-notes', 'Draft the notes.', 'since v1.2.0'),
      want: '/skill:release-notes since v1.2.0',
    },
    {
      name: 'a skill block is recognised without the skill being enumerated',
      text: skillBlock('never-enumerated', 'Body text.'),
      want: '/skill:never-enumerated',
    },
    {
      name: 'ordinary prose is left alone',
      text: 'what time is it?',
      want: null,
    },
    {
      name: 'prose that merely mentions a command is left alone',
      text: 'I ran the review and it looked fine to me, thanks.',
      want: null,
    },
    {
      name: 'empty text is left alone',
      text: '   ',
      want: null,
    },
    {
      name: 'a command with no template never matches',
      text: 'no-template',
      want: null,
    },
    {
      name: 'surrounding whitespace does not prevent a match',
      text: `\n  ${positional.replace('$1', 'x')}  \n`,
      want: '/review x',
    },
  ];

  test.each(cases)('$name', ({ text, want }) => {
    expect(collapser.collapse(text)).toBe(want);
  });

  test('the more specific command wins when two templates share an opening', () => {
    const shared = 'You are a careful reviewer of things. Consider the input.';
    const specific = `${shared} Additionally, check the migrations thoroughly. $ARGUMENTS`;
    const c = collapserWith([
      { name: 'general', template: `${shared} $ARGUMENTS` },
      { name: 'specific', template: specific },
    ]);

    expect(c.collapse(specific.replace('$ARGUMENTS', 'now'))).toBe('/specific now');
  });

  test('a template whose fixed text is too short to tell from prose is not matched', () => {
    const c = collapserWith([{ name: 'go', template: 'Do: $ARGUMENTS' }]);

    expect(c.collapse('Do: the dishes')).toBeNull();
  });

  test('a project with no templates enumerated still collapses skill blocks', () => {
    const c = collapserWith([]);

    expect(c.collapse(positional.replace('$1', 'x'))).toBeNull();
    expect(c.collapse(skillBlock('search', 'Body.'))).toBe('/skill:search');
  });

  test('setCommands replaces the previous set rather than adding to it', () => {
    const c = collapserWith([{ name: 'init', template: noArgs }]);
    expect(c.collapse(noArgs)).toBe('/init');

    c.setCommands([{ name: 'other', template: positional }]);
    expect(c.collapse(noArgs)).toBeNull();
  });
});
