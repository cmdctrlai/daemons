import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { findOmpTemplate } from './omp-commands';

/** Every case lays out a home with a git repo at home/repo and runs in home/repo/app. */
describe('findOmpTemplate looks where omp does, in omp\'s order', () => {
  let root: string;
  let home: string;
  let repo: string;
  let cwd: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omp-cmds-'));
    home = join(root, 'home');
    repo = join(home, 'repo');
    cwd = join(repo, 'app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(cwd, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const put = (rel: string, body: string, name?: string) => {
    const path = rel.startsWith('/') ? rel : join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `---\ndescription: d\n${name ? `name: ${name}\n` : ''}---\n${body}\n`);
  };

  const cases: Array<{
    name: string;
    files: Array<[string, string, string?]>; // [path under root, body, frontmatter name]
    command: string;
    env?: Record<string, string>;
    runIn?: string; // cwd relative to root, default home/repo/app
    want: string | undefined;
  }> = [
    {
      name: 'the project .omp dir beats the project .claude dir',
      files: [['home/repo/app/.claude/commands/x.md', 'claude'], ['home/repo/app/.omp/commands/x.md', 'omp project']],
      command: 'x', want: 'omp project',
    },
    {
      name: 'the omp agent dir beats the project .claude dir',
      files: [['home/repo/app/.claude/commands/x.md', 'claude'], ['home/.omp/agent/commands/x.md', 'omp user']],
      command: 'x', want: 'omp user',
    },
    { name: 'a .claude command at the top level', files: [['home/repo/app/.claude/commands/fixbuild.md', 'fix it']], command: 'fixbuild', want: 'fix it' },
    { name: 'a nested .claude command by its basename', files: [['home/repo/app/.claude/commands/ci/fixbuild.md', 'nested']], command: 'fixbuild', want: 'nested' },
    { name: 'a nested .claude command by dir:name', files: [['home/repo/app/.claude/commands/ci/fixbuild.md', 'nested']], command: 'ci:fixbuild', want: 'nested' },
    {
      name: 'a top-level .claude file beats a nested one of the same name',
      files: [['home/repo/app/.claude/commands/a/x.md', 'nested'], ['home/repo/app/.claude/commands/x.md', 'top']],
      command: 'x', want: 'top',
    },
    {
      name: 'CLAUDE_CONFIG_DIR opts the user claude dir in, ahead of the project one',
      files: [['home/repo/app/.claude/commands/x.md', 'project'], ['claude-cfg/commands/x.md', 'claude user']],
      command: 'x', env: { CLAUDE_CONFIG_DIR: 'claude-cfg' }, want: 'claude user',
    },
    { name: 'without CLAUDE_CONFIG_DIR the user claude dir is not read', files: [['home/.claude/commands/x.md', 'claude user']], command: 'x', want: undefined },
    { name: '.agents/commands at the git root is found from a subdirectory', files: [['home/repo/.agents/commands/x.md', 'agents']], command: 'x', want: 'agents' },
    {
      name: '.agents/commands above the git root is not read',
      files: [['home/ws/repo/.git/HEAD', 'x'], ['home/ws/repo/app/README.md', 'x'], ['home/ws/.agents/commands/x.md', 'above the root']],
      command: 'x', runIn: 'home/ws/repo/app', want: undefined,
    },
    { name: 'home .agent/commands is read as the user dir', files: [['home/.agent/commands/y.md', 'home agents']], command: 'y', want: 'home agents' },
    { name: 'a codex command renamed by its frontmatter', files: [['home/repo/app/.codex/commands/other.md', 'codex', 'fixit']], command: 'fixit', want: 'codex' },
    { name: 'a renamed codex file no longer answers to its file name', files: [['home/repo/app/.codex/commands/other.md', 'codex', 'fixit']], command: 'other', want: undefined },
    { name: 'an opencode project command', files: [['home/repo/app/.opencode/commands/x.md', 'opencode']], command: 'x', want: 'opencode' },
    { name: 'run in home, home/.omp/commands is not a project dir', files: [['home/.omp/commands/x.md', 'not project']], command: 'x', runIn: 'home', want: undefined },
    { name: 'a name with a path separator is not looked up', files: [['home/repo/app/.omp/commands/x.md', 'x']], command: '../x', want: undefined },
  ];

  test.each(cases)('$name', async ({ files, command, env = {}, runIn, want }) => {
    for (const [rel, body, fmName] of files) put(rel, body, fmName);
    const resolvedEnv = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, join(root, v)]));
    const got = await findOmpTemplate(runIn ? join(root, runIn) : cwd, command, resolvedEnv, home);
    expect(got?.trim()).toBe(want);
  });
});
