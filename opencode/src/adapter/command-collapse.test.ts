import { OpenCodeAdapter, type OpenCodeCommand } from './opencode';

/**
 * opencode expands a slash command into a plain user message and keeps no record
 * that a command produced it, so recovering the invocation means matching the
 * stored text back against the templates. These cover that recovery, and – more
 * importantly – that ordinary prose is left alone.
 */
describe('collapseCommandTemplate', () => {
  const echo = [
    'Reply with exactly the following line and nothing else. Do not add commentary.',
    '',
    'ECHO OK. Arguments: $ARGUMENTS',
  ].join('\n');

  const review = [
    'You are a code reviewer. Your job is to review code changes.',
    '',
    'Input: $ARGUMENTS',
    '',
    'Run: `git show $ARGUMENTS` when given a commit.',
  ].join('\n');

  const noArgs = 'Create or update AGENTS.md for this repository, compactly.';

  function adapterWith(commands: OpenCodeCommand[]): OpenCodeAdapter {
    const adapter = new OpenCodeAdapter();
    adapter.setCommands(commands);
    return adapter;
  }

  const adapter = adapterWith([
    { name: 'echo-test', template: echo },
    { name: 'review', template: review },
    { name: 'init', template: noArgs },
    { name: 'no-template' },
  ]);

  const cases: Array<{ name: string; text: string; want: string | null }> = [
    {
      name: 'an expansion with arguments recovers the command and the arguments',
      text: echo.replace('$ARGUMENTS', 'hello world'),
      want: '/echo-test hello world',
    },
    {
      name: 'an expansion with empty arguments recovers just the command',
      text: echo.replace('$ARGUMENTS', ''),
      want: '/echo-test',
    },
    {
      name: 'a template with no placeholder matches exactly',
      text: noArgs,
      want: '/init',
    },
    {
      // opencode has nowhere to substitute them, so it appends them instead.
      name: 'arguments appended to a placeholderless template are recovered',
      text: `${noArgs}\n\nfocus on the build steps`,
      want: '/init focus on the build steps',
    },
    {
      name: 'a repeated placeholder still identifies the command',
      text: review.split('$ARGUMENTS').join('abc123'),
      want: '/review',
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
      text: `\n  ${echo.replace('$ARGUMENTS', 'x')}  \n`,
      want: '/echo-test x',
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      expect(adapter.collapseCommandTemplate(c.text)).toBe(c.want);
    });
  }

  test('the more specific command wins when two templates share an opening', () => {
    const shared = 'You are a careful reviewer of things. Consider the input.';
    const specific = `${shared} Additionally, check the migrations thoroughly. $ARGUMENTS`;
    const a = adapterWith([
      { name: 'general', template: `${shared} $ARGUMENTS` },
      { name: 'specific', template: specific },
    ]);
    expect(a.collapseCommandTemplate(specific.replace('$ARGUMENTS', 'now'))).toBe('/specific now');
  });

  test('a session with no commands enumerated collapses nothing', () => {
    const a = adapterWith([]);
    expect(a.collapseCommandTemplate(echo.replace('$ARGUMENTS', 'x'))).toBeNull();
  });
});
