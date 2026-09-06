import { SkillCatalog, SkillRefresher, parseSlashCommand, toSkillCommands } from './skills';
import type { SkillMetadata, SkillsListEntry } from './adapter/protocol-types';

/**
 * Skill fixtures as `skills/list` returns them (codex 0.153.4). Plugin skills
 * really are named `plugin:skill`, and the colon is the reason a command name is
 * ended by whitespace rather than by any punctuation.
 */
const skill = (over: Partial<SkillMetadata> & { name: string }): SkillMetadata => ({
  description: `${over.name} does a thing`,
  path: `/repo/.agents/skills/${over.name}/SKILL.md`,
  scope: 'repo',
  enabled: true,
  pluginId: null,
  ...over,
});

const PJM = skill({ name: 'pjm', description: 'Add a bug or feature to PROJECTMANAGEMENT.md' });
const MARKETING = skill({ name: 'marketing' });
const PLUGIN = skill({
  name: 'google-drive:google-docs',
  path: '/Users/dev/.codex/plugins/cache/gd/skills/google-docs/SKILL.md',
  scope: 'user',
  pluginId: 'google-drive@openai',
});

describe('parseSlashCommand', () => {
  const cases: {
    name: string;
    text: string;
    expected: { name: string; args: string } | null;
  }[] = [
    { name: 'a bare command', text: '/pjm', expected: { name: 'pjm', args: '' } },
    {
      name: 'a command with arguments',
      text: '/pjm add a bug about the composer',
      expected: { name: 'pjm', args: 'add a bug about the composer' },
    },
    {
      name: 'a plugin command keeps its colon',
      text: '/google-drive:google-docs open the roadmap',
      expected: { name: 'google-drive:google-docs', args: 'open the roadmap' },
    },
    {
      name: 'arguments spanning lines survive whole',
      text: '/pjm first line\nsecond line',
      expected: { name: 'pjm', args: 'first line\nsecond line' },
    },
    {
      name: 'trailing whitespace is not an argument',
      text: '/pjm   ',
      expected: { name: 'pjm', args: '' },
    },
    { name: 'ordinary prose', text: 'add a bug', expected: null },
    { name: 'a slash mid-sentence', text: 'look at foo/bar', expected: null },
    { name: 'an empty message', text: '', expected: null },
    { name: 'a lone slash', text: '/', expected: null },
    // Reads like a command and is not one; the catalog is what settles it.
    { name: 'an absolute path', text: '/tmp/notes.md has the details', expected: { name: 'tmp/notes.md', args: 'has the details' } },
  ];

  test.each(cases)('$name', ({ text, expected }) => {
    expect(parseSlashCommand(text)).toEqual(expected);
  });
});

describe('toSkillCommands', () => {
  const cases: {
    name: string;
    skills: SkillMetadata[];
    expected: { name: string; description?: string; path: string }[];
  }[] = [
    {
      name: 'sorted by name so the menu order is stable',
      skills: [MARKETING, PJM],
      expected: [
        { name: 'marketing', description: 'marketing does a thing', path: MARKETING.path },
        { name: 'pjm', description: PJM.description, path: PJM.path },
      ],
    },
    {
      name: 'a skill the user disabled is not offered',
      skills: [PJM, skill({ name: 'retired', enabled: false })],
      expected: [{ name: 'pjm', description: PJM.description, path: PJM.path }],
    },
    {
      name: 'a repeated name is kept once, first wins',
      skills: [PJM, skill({ name: 'pjm', description: 'shadowed', path: '/other/SKILL.md' })],
      expected: [{ name: 'pjm', description: PJM.description, path: PJM.path }],
    },
    {
      name: 'a skill with no path cannot be invoked, so it is not offered',
      skills: [skill({ name: 'pathless', path: '' })],
      expected: [],
    },
    {
      name: 'a nameless entry is dropped',
      skills: [skill({ name: '  ' })],
      expected: [],
    },
    {
      name: 'an empty description is omitted rather than sent blank',
      skills: [skill({ name: 'terse', description: '   ' })],
      expected: [{ name: 'terse', path: '/repo/.agents/skills/terse/SKILL.md' }],
    },
    { name: 'nothing at all', skills: [], expected: [] },
  ];

  test.each(cases)('$name', ({ skills, expected }) => {
    expect(toSkillCommands(skills)).toEqual(expected);
  });
});

describe('SkillCatalog.record', () => {
  const cases: {
    name: string;
    project: string;
    first: SkillMetadata[];
    second: SkillMetadata[];
    changedAgain: boolean;
  }[] = [
    { name: 'the same set twice is not a change', project: '/repo', first: [PJM], second: [PJM], changedAgain: false },
    { name: 'a new skill is a change', project: '/repo', first: [PJM], second: [PJM, MARKETING], changedAgain: true },
    { name: 'a removed skill is a change', project: '/repo', first: [PJM, MARKETING], second: [PJM], changedAgain: true },
    {
      name: 'a reworded description is a change',
      project: '/repo',
      first: [PJM],
      second: [skill({ name: 'pjm', description: 'Now files chores too' })],
      changedAgain: true,
    },
    {
      // The path is what runs, so a skill that moved must not keep the old one.
      name: 'a moved skill file is a change even under the same name',
      project: '/repo',
      first: [PJM],
      second: [skill({ name: 'pjm', description: PJM.description, path: '/repo/.agents/skills/pjm/v2/SKILL.md' })],
      changedAgain: true,
    },
    {
      name: 'disabling the only skill is a change to an empty set',
      project: '/repo',
      first: [PJM],
      second: [skill({ name: 'pjm', enabled: false })],
      changedAgain: true,
    },
  ];

  test.each(cases)('$name', ({ project, first, second, changedAgain }) => {
    const catalog = new SkillCatalog();
    expect(catalog.record(project, first)).toBe(true);
    expect(catalog.record(project, second)).toBe(changedAgain);
  });

  test('a project with no skills is still recorded, so it is not re-enumerated forever', () => {
    const catalog = new SkillCatalog();
    expect(catalog.record('/empty', [])).toBe(true);
    expect(catalog.has('/empty')).toBe(true);
    expect(catalog.record('/empty', [])).toBe(false);
  });

  test('a nameless project is ignored', () => {
    const catalog = new SkillCatalog();
    expect(catalog.record('', [PJM])).toBe(false);
    expect(catalog.all()).toEqual([]);
  });
});

describe('SkillCatalog.all', () => {
  test('reports name and description per project and never the path', () => {
    const catalog = new SkillCatalog();
    catalog.record('/repo', [PJM, PLUGIN]);
    catalog.record('/other', [MARKETING]);

    expect(catalog.all()).toEqual([
      {
        project: '/repo',
        commands: [
          { name: 'google-drive:google-docs', description: 'google-drive:google-docs does a thing' },
          { name: 'pjm', description: PJM.description },
        ],
      },
      { project: '/other', commands: [{ name: 'marketing', description: 'marketing does a thing' }] },
    ]);
    expect(JSON.stringify(catalog.all())).not.toContain('SKILL.md');
  });
});

/**
 * The whole point of the catalog: `turn/start` resolves a skill by path, and the
 * wire protocol never carried one. Resolving to the wrong project's skill would
 * run silently and do the wrong thing, so the lookup is scoped, not global.
 */
describe('SkillCatalog.resolve', () => {
  const catalog = new SkillCatalog();
  catalog.record('/repo', [PJM, PLUGIN]);
  catalog.record('/other', [skill({ name: 'pjm', path: '/other/.agents/skills/pjm/SKILL.md' })]);

  const cases: {
    name: string;
    project: string;
    text: string;
    expected: { name: string; path: string; args: string } | null;
  }[] = [
    {
      name: 'a bare command resolves with no arguments',
      project: '/repo',
      text: '/pjm',
      expected: { name: 'pjm', path: PJM.path, args: '' },
    },
    {
      name: 'arguments come through unchanged',
      project: '/repo',
      text: '/pjm file BUG-1 about the composer',
      expected: { name: 'pjm', path: PJM.path, args: 'file BUG-1 about the composer' },
    },
    {
      name: 'the same name in another project resolves to that project’s file',
      project: '/other',
      text: '/pjm',
      expected: { name: 'pjm', path: '/other/.agents/skills/pjm/SKILL.md', args: '' },
    },
    {
      name: 'a plugin command resolves',
      project: '/repo',
      text: '/google-drive:google-docs hi',
      expected: { name: 'google-drive:google-docs', path: PLUGIN.path, args: 'hi' },
    },
    { name: 'ordinary prose is left alone', project: '/repo', text: 'file a bug', expected: null },
    { name: 'a name this project does not have stays text', project: '/repo', text: '/marketing draft a post', expected: null },
    { name: 'a path that reads like a command stays text', project: '/repo', text: '/tmp/notes.md look here', expected: null },
    { name: 'a project never enumerated stays text', project: '/unknown', text: '/pjm', expected: null },
    {
      // Codex really ships Presentations, Spreadsheets and Codex-tab-cleanup, and
      // the composer's menu matches case-insensitively.
      name: 'a unique case-insensitive match resolves',
      project: '/repo',
      text: '/PJM file a bug',
      expected: { name: 'pjm', path: PJM.path, args: 'file a bug' },
    },
    {
      name: 'a plugin command resolves case-insensitively too',
      project: '/repo',
      text: '/GOOGLE-DRIVE:Google-Docs',
      expected: { name: 'google-drive:google-docs', path: PLUGIN.path, args: '' },
    },
  ];

  test.each(cases)('$name', ({ project, text, expected }) => {
    expect(catalog.resolve(project, text)).toEqual(expected);
  });

  test('an exact match wins over one that differs only in case', () => {
    const both = new SkillCatalog();
    both.record('/repo', [
      skill({ name: 'Report', path: '/repo/.agents/skills/Report/SKILL.md' }),
      skill({ name: 'report', path: '/repo/.agents/skills/report/SKILL.md' }),
    ]);
    expect(both.resolve('/repo', '/report')).toMatchObject({ path: '/repo/.agents/skills/report/SKILL.md' });
    expect(both.resolve('/repo', '/Report')).toMatchObject({ path: '/repo/.agents/skills/Report/SKILL.md' });
  });

  test('an ambiguous case-insensitive match stays text rather than guessing', () => {
    const both = new SkillCatalog();
    both.record('/repo', [
      skill({ name: 'Report', path: '/repo/.agents/skills/Report/SKILL.md' }),
      skill({ name: 'rePort', path: '/repo/.agents/skills/rePort/SKILL.md' }),
    ]);
    expect(both.resolve('/repo', '/REPORT')).toBeNull();
  });
});

/**
 * A project directory that has gone still has rollouts on disk, so it stays in
 * the session list – but a turn for it runs in the home directory instead. Going
 * on offering its commands would advertise one set of skills and run another.
 */
describe('SkillCatalog.retain', () => {
  const cases: {
    name: string;
    recorded: string[];
    keep: string[];
    expectedDropped: boolean;
    expectedProjects: string[];
  }[] = [
    { name: 'nothing to drop', recorded: ['/a', '/b'], keep: ['/a', '/b'], expectedDropped: false, expectedProjects: ['/a', '/b'] },
    { name: 'a project that vanished is forgotten', recorded: ['/a', '/b'], keep: ['/a'], expectedDropped: true, expectedProjects: ['/a'] },
    { name: 'keeping nothing empties the catalog', recorded: ['/a'], keep: [], expectedDropped: true, expectedProjects: [] },
    { name: 'a project not yet recorded is not invented', recorded: ['/a'], keep: ['/a', '/c'], expectedDropped: false, expectedProjects: ['/a'] },
    { name: 'an empty catalog drops nothing', recorded: [], keep: ['/a'], expectedDropped: false, expectedProjects: [] },
  ];

  test.each(cases)('$name', ({ recorded, keep, expectedDropped, expectedProjects }) => {
    const catalog = new SkillCatalog();
    for (const project of recorded) catalog.record(project, [PJM]);
    expect(catalog.retain(keep)).toBe(expectedDropped);
    expect(catalog.all().map((s) => s.project)).toEqual(expectedProjects);
  });

  test('a dropped project no longer resolves its commands', () => {
    const catalog = new SkillCatalog();
    catalog.record('/gone', [PJM]);
    catalog.retain([]);
    expect(catalog.resolve('/gone', '/pjm')).toBeNull();
    expect(catalog.has('/gone')).toBe(false);
  });
});


/**
 * Every enumeration spawns a codex app-server, so the refresher decides how
 * often that happens – and, more importantly, that a caller waiting on a
 * particular project really gets it.
 */
describe('SkillRefresher', () => {
  /** Records the directories it was asked about and answers from a fixture map. */
  class FakeLister {
    calls: string[][] = [];
    fail?: Error;
    /** Set to hold the next call open until the returned release is invoked. */
    private hold?: { entered: () => void; release: Promise<void> };

    constructor(private readonly entries: Record<string, SkillMetadata[]> = {}) {}

    /** Blocks the next listSkills call; resolves once it has been entered. */
    holdNextCall(): { entered: Promise<void>; release: () => void } {
      let releaseFn: () => void = () => {};
      let enteredFn: () => void = () => {};
      const entered = new Promise<void>((r) => { enteredFn = r; });
      const release = new Promise<void>((r) => { releaseFn = r; });
      this.hold = { entered: enteredFn, release };
      return { entered, release: releaseFn };
    }

    async listSkills(cwds: string[]): Promise<SkillsListEntry[]> {
      this.calls.push(cwds);
      const hold = this.hold;
      if (hold) {
        this.hold = undefined;
        hold.entered();
        await hold.release;
      }
      if (this.fail) throw this.fail;
      return cwds.map((cwd) => ({ cwd, skills: this.entries[cwd] ?? [], errors: [] }));
    }
  }

  function build(discovered: string[], entries: Record<string, SkillMetadata[]> = {}) {
    const catalog = new SkillCatalog();
    const lister = new FakeLister(entries);
    const warnings: string[] = [];
    const refresher = new SkillRefresher(catalog, lister, () => discovered, (m) => warnings.push(m));
    return { catalog, lister, refresher, warnings };
  }

  describe('refresh', () => {
    const cases: {
      name: string;
      discovered: string[];
      extra?: string;
      entries?: Record<string, SkillMetadata[]>;
      expectedCalls: string[][];
      expectedChanged: boolean;
    }[] = [
      {
        name: 'asks about every discovered project in one call',
        discovered: ['/a', '/b'],
        entries: { '/a': [PJM] },
        expectedCalls: [['/a', '/b']],
        expectedChanged: true,
      },
      {
        name: 'adds the named project to the discovered ones',
        discovered: ['/a'],
        extra: '/new',
        entries: { '/new': [PJM] },
        expectedCalls: [['/a', '/new']],
        expectedChanged: true,
      },
      {
        name: 'a named project already discovered is not asked about twice',
        discovered: ['/a'],
        extra: '/a',
        expectedCalls: [['/a']],
        expectedChanged: true,
      },
      {
        name: 'nothing to enumerate spawns nothing',
        discovered: [],
        expectedCalls: [],
        expectedChanged: false,
      },
    ];

    test.each(cases)('$name', async ({ discovered, extra, entries, expectedCalls, expectedChanged }) => {
      const { lister, refresher } = build(discovered, entries);
      expect(await refresher.refresh(extra)).toBe(expectedChanged);
      expect(lister.calls).toEqual(expectedCalls);
    });

    test('an unchanged set does not ask for a second report', async () => {
      const { refresher } = build(['/a'], { '/a': [PJM] });
      expect(await refresher.refresh()).toBe(true);
      expect(await refresher.refresh()).toBe(false);
    });

    test('a failed enumeration is warned about, not thrown', async () => {
      const { refresher, lister, warnings } = build(['/a']);
      lister.fail = new Error('spawn codex ENOENT');
      expect(await refresher.refresh()).toBe(false);
      expect(warnings).toEqual(['Could not enumerate codex skills: spawn codex ENOENT']);
    });

    test('a failure leaves the queue usable', async () => {
      const { refresher, lister } = build(['/a'], { '/a': [PJM] });
      lister.fail = new Error('boom');
      expect(await refresher.refresh()).toBe(false);
      lister.fail = undefined;
      expect(await refresher.refresh()).toBe(true);
    });

    test('unparseable skill files are surfaced without failing the enumeration', async () => {
      const catalog = new SkillCatalog();
      const warnings: string[] = [];
      const refresher = new SkillRefresher(
        catalog,
        {
          async listSkills() {
            return [{ cwd: '/a', skills: [PJM], errors: [{ path: '/a/bad/SKILL.md', message: 'no frontmatter' }] }];
          },
        },
        () => ['/a'],
        (m) => warnings.push(m)
      );

      expect(await refresher.refresh()).toBe(true);
      expect(warnings).toEqual(['[Skills] /a/bad/SKILL.md: no frontmatter']);
      expect(catalog.has('/a')).toBe(true);
    });
  });

  test('a project that disappeared stops being offered', async () => {
    const catalog = new SkillCatalog();
    let discovered = ['/a', '/gone'];
    const lister = new FakeLister({ '/a': [PJM], '/gone': [MARKETING] });
    const refresher = new SkillRefresher(catalog, lister, () => discovered);

    await refresher.refresh();
    expect(catalog.all().map((s) => s.project).sort()).toEqual(['/a', '/gone']);

    discovered = ['/a'];
    expect(await refresher.refresh()).toBe(true);
    expect(catalog.all().map((s) => s.project)).toEqual(['/a']);
  });

  describe('ensureProject', () => {
    test('enumerates a project nobody has seen', async () => {
      const { refresher, lister, catalog } = build(['/a'], { '/new': [PJM] });
      expect(await refresher.ensureProject('/new')).toBe(true);
      expect(lister.calls).toEqual([['/a', '/new']]);
      expect(catalog.resolve('/new', '/pjm')).not.toBeNull();
    });

    test('a project already in the catalog costs nothing', async () => {
      const { refresher, lister, catalog } = build(['/a']);
      catalog.record('/a', [PJM]);
      expect(await refresher.ensureProject('/a')).toBe(false);
      expect(lister.calls).toEqual([]);
    });

    test('no project named is not an enumeration', async () => {
      const { refresher, lister } = build(['/a']);
      expect(await refresher.ensureProject(undefined)).toBe(false);
      expect(lister.calls).toEqual([]);
    });

    /**
     * The failure that matters: a codex that cannot answer – missing binary, a
     * version with no skills/list, an app-server that never replies – records
     * nothing, so a catalog check alone would make every single message pay the
     * attempt again, up to the request timeout, for the life of the daemon.
     */
    test('a project whose enumeration failed is not retried on the next message', async () => {
      const { refresher, lister } = build(['/a']);
      lister.fail = new Error('skills/list timed out after 30000ms');

      expect(await refresher.ensureProject('/new')).toBe(false);
      expect(await refresher.ensureProject('/new')).toBe(false);
      expect(await refresher.ensureProject('/new')).toBe(false);
      expect(lister.calls).toHaveLength(1);
    });

    test('two turns starting together in one new project share a single enumeration', async () => {
      const { refresher, lister } = build(['/a'], { '/new': [PJM] });
      const [first, second] = await Promise.all([
        refresher.ensureProject('/new'),
        refresher.ensureProject('/new'),
      ]);
      expect(lister.calls).toEqual([['/a', '/new']]);
      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    test('a full refresh still covers a project ensureProject gave up on', async () => {
      const { refresher, lister, catalog } = build(['/a'], { '/new': [PJM] });
      lister.fail = new Error('boom');
      await refresher.ensureProject('/new');

      lister.fail = undefined;
      expect(await refresher.refresh('/new')).toBe(true);
      expect(catalog.has('/new')).toBe(true);
    });
  });

  /**
   * The reason enumerations queue instead of collapsing: a full refresh in
   * flight when a turn starts in a project that refresh never looked at.
   * Collapsing the second request onto the first would report success having
   * enumerated nothing, and the turn would go out as text.
   */
  test('a request made during an in-flight refresh still gets its own project', async () => {
    const { refresher, lister, catalog } = build(['/a'], { '/new': [PJM] });
    const gate = lister.holdNextCall();

    const first = refresher.refresh();
    await gate.entered;
    const second = refresher.ensureProject('/new');
    gate.release();

    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(lister.calls).toEqual([['/a'], ['/a', '/new']]);
    expect(catalog.resolve('/new', '/pjm')).toEqual({ name: 'pjm', path: PJM.path, args: '' });
  });
});
