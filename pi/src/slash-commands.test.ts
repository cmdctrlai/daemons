import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { filterSlashCommands, SlashCommandRegistry } from './slash-commands';
import type { PiCommand, PiCommandSource } from './pi-commands';

const cmd = (
  name: string,
  description?: string,
  source: PiCommandSource = 'prompt',
): PiCommand => ({
  name,
  source,
  ...(description !== undefined ? { description } : {}),
});

describe('filterSlashCommands', () => {
  const cases: Array<{ name: string; input: PiCommand[]; expected: unknown[] }> = [
    {
      name: 'carries a prompt template description through',
      input: [cmd('review', 'Review the working diff')],
      expected: [{ name: 'review', description: 'Review the working diff' }],
    },
    {
      name: 'offers a skill under the name pi expands, prefix and all',
      input: [cmd('skill:release-notes', 'Draft release notes', 'skill')],
      expected: [{ name: 'skill:release-notes', description: 'Draft release notes' }],
    },
    {
      name: 'withholds extension commands, whose output the daemon cannot see',
      input: [cmd('session-name', 'Set session name', 'extension')],
      expected: [],
    },
    {
      name: 'keeps templates and skills when an extension sits between them',
      input: [
        cmd('review', 'Review'),
        cmd('checkpoint', 'Git checkpoint', 'extension'),
        cmd('skill:search', 'Web search', 'skill'),
      ],
      expected: [
        { name: 'review', description: 'Review' },
        { name: 'skill:search', description: 'Web search' },
      ],
    },
    {
      name: 'omits description when pi gives none',
      input: [cmd('bare')],
      expected: [{ name: 'bare' }],
    },
    {
      name: 'drops a blank description rather than emitting an empty string',
      input: [cmd('spaced', '   ')],
      expected: [{ name: 'spaced' }],
    },
    {
      name: 'withholds internal underscore-prefixed commands',
      input: [cmd('_private'), cmd('__internal')],
      expected: [],
    },
    {
      name: 'sorts alphabetically so menu order is stable',
      input: [cmd('zebra'), cmd('init', 'create AGENTS.md'), cmd('alpha')],
      expected: [
        { name: 'alpha' },
        { name: 'init', description: 'create AGENTS.md' },
        { name: 'zebra' },
      ],
    },
    {
      name: 'collapses duplicates, keeping the first',
      input: [cmd('review', 'first'), cmd('review', 'second')],
      expected: [{ name: 'review', description: 'first' }],
    },
    {
      name: 'drops blank names',
      input: [cmd(''), cmd('   '), cmd('review')],
      expected: [{ name: 'review' }],
    },
    {
      name: 'trims surrounding whitespace before matching',
      input: [cmd(' review ', 'desc')],
      expected: [{ name: 'review', description: 'desc' }],
    },
  ];

  test.each(cases)('$name', ({ input, expected }) => {
    expect(filterSlashCommands(input)).toEqual(expected);
  });
});

describe('SlashCommandRegistry', () => {
  const cases: Array<{
    name: string;
    runs: Array<[string, PiCommand[]]>;
    changed: boolean[];
    expected: unknown[];
  }> = [
    {
      name: 'records a new project',
      runs: [['/a', [cmd('review')]]],
      changed: [true],
      expected: [{ project: '/a', commands: [{ name: 'review' }] }],
    },
    {
      name: 'an unchanged set is not a change',
      runs: [['/a', [cmd('review')]], ['/a', [cmd('review')]]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'review' }] }],
    },
    {
      name: 'reordering the command list is not a change, because we sort',
      runs: [['/a', [cmd('review'), cmd('init')]], ['/a', [cmd('init'), cmd('review')]]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'init' }, { name: 'review' }] }],
    },
    {
      name: 'a changed description is a change',
      runs: [['/a', [cmd('review', 'old')]], ['/a', [cmd('review', 'new')]]],
      changed: [true, true],
      expected: [{ project: '/a', commands: [{ name: 'review', description: 'new' }] }],
    },
    {
      name: 'a removed command is a change',
      runs: [['/a', [cmd('review'), cmd('init')]], ['/a', [cmd('review')]]],
      changed: [true, true],
      expected: [{ project: '/a', commands: [{ name: 'review' }] }],
    },
    {
      name: 'a project whose commands are all withheld records an empty set',
      runs: [['/a', [cmd('checkpoint', 'Git checkpoint', 'extension')]]],
      changed: [true],
      expected: [{ project: '/a', commands: [] }],
    },
    {
      name: 'projects are tracked independently',
      runs: [['/a', [cmd('review')]], ['/b', [cmd('init')]]],
      changed: [true, true],
      expected: [
        { project: '/a', commands: [{ name: 'review' }] },
        { project: '/b', commands: [{ name: 'init' }] },
      ],
    },
    {
      name: 'an empty advertisement is ignored rather than wiping the set',
      runs: [['/a', [cmd('review')]], ['/a', []]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'review' }] }],
    },
    {
      name: 'a run with no project is ignored',
      runs: [['', [cmd('review')]]],
      changed: [false],
      expected: [],
    },
  ];

  test.each(cases)('$name', ({ runs, changed, expected }) => {
    const registry = new SlashCommandRegistry();
    const observed = runs.map(([project, commands]) => registry.record(project, commands));

    expect(observed).toEqual(changed);
    expect(registry.all()).toEqual(expected);
  });
});

describe('SlashCommandRegistry persistence', () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pi-slash-cache-'));
    cachePath = join(dir, 'nested', 'slash-commands.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('survives a restart, so a daemon update does not take the menu away', () => {
    new SlashCommandRegistry(cachePath).record('/a', [cmd('review', 'Review the working diff')]);

    expect(new SlashCommandRegistry(cachePath).all()).toEqual([
      { project: '/a', commands: [{ name: 'review', description: 'Review the working diff' }] },
    ]);
  });

  test('a restored set is recognised as unchanged', () => {
    new SlashCommandRegistry(cachePath).record('/a', [cmd('review')]);

    expect(new SlashCommandRegistry(cachePath).record('/a', [cmd('review')])).toBe(false);
  });

  test('starts empty when there is no cache yet', () => {
    expect(new SlashCommandRegistry(cachePath).all()).toEqual([]);
  });

  test('a corrupt cache is discarded rather than failing startup', () => {
    const path = join(dir, 'corrupt.json');
    writeFileSync(path, 'not json');

    expect(new SlashCommandRegistry(path).all()).toEqual([]);
  });

  test('an unwritable cache path does not break recording', () => {
    const registry = new SlashCommandRegistry(join(dir, 'file.txt', 'cache.json'));
    writeFileSync(join(dir, 'file.txt'), 'blocks the directory');

    expect(registry.record('/a', [cmd('review')])).toBe(true);
    expect(registry.all()).toEqual([{ project: '/a', commands: [{ name: 'review' }] }]);
  });
});
