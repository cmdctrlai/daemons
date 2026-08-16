import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { filterSlashCommands, SlashCommandRegistry } from './slash-commands';

describe('filterSlashCommands', () => {
  const cases: Array<{ name: string; input: string[]; expected: unknown[] }> = [
    {
      name: 'passes a user skill through untouched',
      input: ['release-notes'],
      expected: [{ name: 'release-notes' }],
    },
    {
      name: 'annotates a known built-in',
      input: ['rename'],
      expected: [{ name: 'rename', description: 'Rename this session', usage_hint: '<title>' }],
    },
    {
      name: 'withholds the commands whose setting does not survive a one-shot run',
      input: ['clear', 'model', 'color', 'effort', 'fast'],
      expected: [],
    },
    {
      name: 'withholds the commands the CLI answers as a local command',
      input: [
        'agents', 'autocompact', 'config', 'context', 'extra-usage', 'goal', 'heapdump',
        'mcp', 'recap', 'reload-skills', 'usage', 'usage-credits', 'workflow-launch-exec',
      ],
      expected: [],
    },
    {
      name: 'withholds internal underscore-prefixed commands',
      input: ['__remote-workflow', '_private'],
      expected: [],
    },
    {
      name: 'sorts alphabetically so menu order is stable',
      input: ['zebra', 'insights', 'alpha'],
      expected: [
        { name: 'alpha' },
        { name: 'insights', description: 'Generate a usage insights report' },
        { name: 'zebra' },
      ],
    },
    {
      name: 'collapses duplicates',
      input: ['deploy', 'deploy'],
      expected: [{ name: 'deploy' }],
    },
    {
      name: 'drops blank names',
      input: ['', '   ', 'deploy'],
      expected: [{ name: 'deploy' }],
    },
    {
      name: 'trims surrounding whitespace before matching',
      input: [' model ', ' compact '],
      expected: [{ name: 'compact', description: 'Summarize the conversation to free up context' }],
    },
    {
      name: 'keeps a command whose name merely contains a withheld one',
      input: ['model-picker', 'clearcache'],
      expected: [{ name: 'clearcache' }, { name: 'model-picker' }],
    },
  ];

  test.each(cases)('$name', ({ input, expected }) => {
    expect(filterSlashCommands(input)).toEqual(expected);
  });
});

describe('SlashCommandRegistry', () => {
  const cases: Array<{ name: string; runs: Array<[string, string[]]>; changed: boolean[]; expected: unknown[] }> = [
    {
      name: 'records a new project',
      runs: [['/a', ['deploy']]],
      changed: [true],
      expected: [{ project: '/a', commands: [{ name: 'deploy' }] }],
    },
    {
      name: 'an unchanged set is not a change',
      runs: [['/a', ['deploy']], ['/a', ['deploy']]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'deploy' }] }],
    },
    {
      name: 'reordering the CLI list is not a change, because we sort',
      runs: [['/a', ['deploy', 'build']], ['/a', ['build', 'deploy']]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'build' }, { name: 'deploy' }] }],
    },
    {
      name: 'a set that differs only by a withheld command is not a change',
      runs: [['/a', ['deploy']], ['/a', ['deploy', 'model']]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'deploy' }] }],
    },
    {
      name: 'a removed command is a change',
      runs: [['/a', ['deploy', 'build']], ['/a', ['deploy']]],
      changed: [true, true],
      expected: [{ project: '/a', commands: [{ name: 'deploy' }] }],
    },
    {
      name: 'projects are tracked independently',
      runs: [['/a', ['deploy']], ['/b', ['build']]],
      changed: [true, true],
      expected: [
        { project: '/a', commands: [{ name: 'deploy' }] },
        { project: '/b', commands: [{ name: 'build' }] },
      ],
    },
    {
      name: 'an empty advertisement is ignored rather than wiping the set',
      runs: [['/a', ['deploy']], ['/a', []]],
      changed: [true, false],
      expected: [{ project: '/a', commands: [{ name: 'deploy' }] }],
    },
    {
      name: 'a run with no working directory is ignored',
      runs: [['', ['deploy']]],
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
    dir = mkdtempSync(join(tmpdir(), 'slash-cache-'));
    cachePath = join(dir, 'nested', 'slash-commands.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('survives a restart, so a daemon update does not take the menu away', () => {
    new SlashCommandRegistry(cachePath).record('/a', ['deploy']);

    expect(new SlashCommandRegistry(cachePath).all()).toEqual([
      { project: '/a', commands: [{ name: 'deploy' }] },
    ]);
  });

  test('a restored set is recognised as unchanged', () => {
    new SlashCommandRegistry(cachePath).record('/a', ['deploy']);

    expect(new SlashCommandRegistry(cachePath).record('/a', ['deploy'])).toBe(false);
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

    expect(registry.record('/a', ['deploy'])).toBe(true);
    expect(registry.all()).toEqual([{ project: '/a', commands: [{ name: 'deploy' }] }]);
  });
});
