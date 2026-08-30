import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { filterSlashCommands, SlashCommandRegistry } from './slash-commands';
import type { OpenCodeCommand } from './adapter/opencode';

const cmd = (name: string, description?: string, source?: OpenCodeCommand['source']): OpenCodeCommand => ({
  name,
  ...(description !== undefined ? { description } : {}),
  ...(source !== undefined ? { source } : {}),
});

describe('filterSlashCommands', () => {
  const cases: Array<{ name: string; input: OpenCodeCommand[]; expected: unknown[] }> = [
    {
      name: 'carries the opencode description through',
      input: [cmd('review', 'review changes', 'command')],
      expected: [{ name: 'review', description: 'review changes' }],
    },
    {
      name: 'passes a user skill through by name and description',
      input: [cmd('release-notes', 'Generate a release notes draft', 'skill')],
      expected: [{ name: 'release-notes', description: 'Generate a release notes draft' }],
    },
    {
      name: 'omits description when opencode gives none',
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
  const cases: Array<{ name: string; runs: Array<[string, OpenCodeCommand[]]>; changed: boolean[]; expected: unknown[] }> = [
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
    dir = mkdtempSync(join(tmpdir(), 'oc-slash-cache-'));
    cachePath = join(dir, 'nested', 'slash-commands.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('survives a restart, so a daemon update does not take the menu away', () => {
    new SlashCommandRegistry(cachePath).record('/a', [cmd('review', 'review changes')]);

    expect(new SlashCommandRegistry(cachePath).all()).toEqual([
      { project: '/a', commands: [{ name: 'review', description: 'review changes' }] },
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
