/**
 * Tests for discoverCliUserTitles – scans ~/.claude/sessions/<pid>.json for
 * the live value of Claude Code's /rename command.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import {
  decodeProjectPath,
  discoverCliUserTitles,
  discoverSessions,
  encodeProjectPath,
  generateTitle,
  isProjectCwd,
  PathDecodeEnv,
} from './session-discovery';

// Claude Code's own folder name for a project: every non-alphanumeric becomes '-',
// and a name over 200 characters is cut there and suffixed with a hash of the path.
function claudeProjectFolder(cwd: string): string {
  const encoded = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (encoded.length <= 200) return encoded;
  let h = 0;
  for (let i = 0; i < cwd.length; i++) h = ((h << 5) - h + cwd.charCodeAt(i)) | 0;
  return `${encoded.slice(0, 200)}-${Math.abs(h).toString(36)}`;
}

describe('discoverCliUserTitles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-rename-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  type Case = {
    name: string;
    files: Record<string, string>;
    expected: Array<[string, string]>;
  };

  const cases: Case[] = [
    {
      name: 'reads name from real-world per-PID JSON',
      files: {
        '68420.json': JSON.stringify({
          pid: 68420,
          sessionId: '2f2ef9da-d73c-456f-a819-18e27d3ada41',
          name: 'Reprice',
          updatedAt: 1778347637194,
        }),
      },
      expected: [['2f2ef9da-d73c-456f-a819-18e27d3ada41', 'Reprice']],
    },
    {
      name: 'reads multi-word names',
      files: {
        '7164.json': JSON.stringify({
          pid: 7164,
          sessionId: '01b63b18-9562-4040-834a-7bc198d935d2',
          name: 'claude code leak discovery',
        }),
      },
      expected: [['01b63b18-9562-4040-834a-7bc198d935d2', 'claude code leak discovery']],
    },
    {
      name: 'aggregates multiple files into one map',
      files: {
        '111.json': JSON.stringify({ pid: 111, sessionId: 'aaa', name: 'one' }),
        '222.json': JSON.stringify({ pid: 222, sessionId: 'bbb', name: 'two' }),
      },
      expected: [
        ['aaa', 'one'],
        ['bbb', 'two'],
      ],
    },
    {
      name: 'skips files missing sessionId',
      files: {
        'orphan.json': JSON.stringify({ pid: 1, name: 'no-id' }),
      },
      expected: [],
    },
    {
      name: 'skips files missing name',
      files: {
        'noname.json': JSON.stringify({ pid: 1, sessionId: 'abc' }),
      },
      expected: [],
    },
    {
      name: 'skips empty / whitespace-only names',
      files: {
        'empty.json': JSON.stringify({ pid: 1, sessionId: 'abc', name: '   ' }),
      },
      expected: [],
    },
    {
      name: 'ignores non-.json files',
      files: {
        'something.txt': 'not json',
        '999.json': JSON.stringify({ pid: 999, sessionId: 'xyz', name: 'kept' }),
      },
      expected: [['xyz', 'kept']],
    },
    {
      name: 'tolerates malformed JSON without throwing',
      files: {
        'broken.json': '{not valid json',
        'good.json': JSON.stringify({ pid: 1, sessionId: 'good-id', name: 'good-name' }),
      },
      expected: [['good-id', 'good-name']],
    },
    {
      name: 'returns empty map when directory is empty',
      files: {},
      expected: [],
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      for (const [filename, content] of Object.entries(tc.files)) {
        fs.writeFileSync(path.join(tempDir, filename), content);
      }
      const result = discoverCliUserTitles(tempDir);
      const actual = [...result.entries()].sort();
      const expected = [...tc.expected].sort();
      expect(actual).toEqual(expected);
    });
  }

  test('returns empty map when directory does not exist', () => {
    const result = discoverCliUserTitles(path.join(tempDir, 'does-not-exist'));
    expect(result.size).toBe(0);
  });
});

describe('generateTitle', () => {
  type Case = { name: string; message: string; expected: string };

  const cases: Case[] = [
    {
      name: 'ordinary first message becomes the title',
      message: 'Fix the login redirect',
      expected: 'Fix the login redirect',
    },
    {
      name: 'a pasted first message titles on its text, not the wrapper',
      message:
        '\n\n<pasted_content id="c261">\nThis is the first message and I dictated it\n</pasted_content id="c261">\n',
      expected: 'This is the first message and I dictated it',
    },
    {
      name: 'typed text around a paste keeps the typed lead',
      message: 'look at this <pasted_content id="d81e">\nstack trace\n</pasted_content id="d81e">',
      expected: 'look at this stack trace',
    },
    {
      name: 'only the first line is used',
      message: 'first line\nsecond line',
      expected: 'first line',
    },
    {
      name: 'a long line truncates at a word boundary',
      message:
        'This first line runs well past the fifty character limit that titles are held to',
      expected: 'This first line runs well past the fifty...',
    },
    {
      name: 'empty message yields no title',
      message: '',
      expected: '',
    },
    {
      name: 'whitespace-only message yields no title',
      message: '   \n  ',
      expected: '',
    },
  ];

  it.each(cases)('$name', ({ message, expected }) => {
    expect(generateTitle(message)).toBe(expected);
  });
});

describe('encodeProjectPath', () => {
  type Case = { name: string; input: string; expected: string };

  const cases: Case[] = [
    { name: 'slashes, dots and hyphens', input: '/Users/alice/src/my-proj.web', expected: '-Users-alice-src-my-proj-web' },
    { name: 'a Windows drive and backslashes', input: 'C:\\Users\\first.last', expected: 'C--Users-first-last' },
    { name: 'spaces and tilde', input: 'G:\\My Drive\\~tmp', expected: 'G--My-Drive--tmp' },
  ];

  it.each(cases)('$name', ({ input, expected }) => {
    expect(encodeProjectPath(input)).toBe(expected);
  });
});

describe('decodeProjectPath on the real filesystem', () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'decode-test-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  type Case = { name: string; dirs: string[]; target: string };

  // Each case lives under its own top-level directory so cases cannot match each other.
  const cases: Case[] = [
    { name: 'a hyphenated directory resolves whole', dirs: ['x/my-proj'], target: 'x/my-proj' },
    { name: 'a hyphenated name wins over a split when both exist', dirs: ['y/a-b', 'y/a/b'], target: 'y/a-b' },
    { name: 'a dead-end hyphenated name falls through to the split', dirs: ['z/a-b', 'z/a/b-c'], target: 'z/a/b-c' },
    { name: 'dots in a directory name', dirs: ['u/first.last/src'], target: 'u/first.last/src' },
    { name: 'spaces in a directory name', dirs: ['s/My Drive/Home'], target: 's/My Drive/Home' },
    { name: 'tilde and a leading dot', dirs: ['t/~scratch/.config'], target: 't/~scratch/.config' },
  ];

  it.each(cases)('$name', ({ dirs, target }) => {
    for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
    const real = path.join(root, target);
    expect(decodeProjectPath(encodeProjectPath(real))).toBe(real);
  });

  it('falls back to reading every hyphen as a slash when nothing matches', () => {
    const encoded = encodeProjectPath(path.join(root, 'missing', 'a-b'));
    expect(decodeProjectPath(encoded)).toBe('/' + encoded.slice(1).split('-').join('/'));
  });

  it('decodes a 28-part name quickly under a 64 MB heap', () => {
    const parts = Array.from({ length: 28 }, (_, i) => `zz${i}`);
    const name = encodeProjectPath(root) + '-' + parts.join('-');
    const script = `
      const { decodeProjectPath } = require(${JSON.stringify(path.join(__dirname, 'session-discovery.ts'))});
      const start = Date.now();
      const decoded = decodeProjectPath(${JSON.stringify(name)});
      console.log(JSON.stringify({ ms: Date.now() - start, decoded }));
    `;
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=64', '-r', 'ts-node/register/transpile-only', '-e', script],
      { cwd: path.join(__dirname, '..'), encoding: 'utf-8', timeout: 60000 },
    );
    // An out-of-memory abort shows up here as SIGABRT.
    expect(child.signal ?? child.status).toBe(0);
    const { ms, decoded } = JSON.parse(child.stdout.trim().split('\n').pop()!);
    expect(decoded.endsWith('/' + parts.join('/'))).toBe(true);
    expect(ms).toBeLessThan(1000);
  }, 60000);
});

describe('decodeProjectPath on Windows', () => {
  const tree: Record<string, string[]> = {
    'C:\\': ['Program Files', 'Users'],
    'C:\\Users': ['Public', 'first.last'],
    'C:\\Users\\first.last': ['src'],
    'C:\\Users\\first.last\\src': ['my-proj'],
    'G:\\': ['My Drive'],
    'G:\\My Drive': ['Home'],
    'H:\\': ['My Drive'],
    'H:\\My Drive': ['Home'],
  };

  type Case = { name: string; dirName: string; expected: string };

  const cases: Case[] = [
    { name: 'a bare drive is its root', dirName: 'C--', expected: 'C:\\' },
    { name: 'the drive is kept and a dotted user name recovered', dirName: 'C--Users-first-last', expected: 'C:\\Users\\first.last' },
    { name: 'a hyphenated project under the user', dirName: 'C--Users-first-last-src-my-proj', expected: 'C:\\Users\\first.last\\src\\my-proj' },
    { name: 'a space in a directory name on G:', dirName: 'G--My-Drive-Home', expected: 'G:\\My Drive\\Home' },
    { name: 'the same folders on H: stay distinct', dirName: 'H--My-Drive-Home', expected: 'H:\\My Drive\\Home' },
    { name: 'matching ignores case', dirName: 'c--users-FIRST-last', expected: 'c:\\Users\\first.last' },
    { name: 'no match keeps the drive in the fallback', dirName: 'C--Users-nobody-x', expected: 'C:\\Users\\nobody\\x' },
    { name: 'a name with no drive is not walked', dirName: '--server-share-x', expected: '//server/share/x' },
  ];

  it.each(cases)('$name', ({ dirName, expected }) => {
    const listed: string[] = [];
    const env: PathDecodeEnv = {
      platform: 'win32',
      listDirs: (dir) => {
        listed.push(dir);
        // Windows paths are case-insensitive.
        const key = Object.keys(tree).find(k => k.toLowerCase() === dir.toLowerCase());
        return key ? tree[key] : [];
      },
    };
    expect(decodeProjectPath(dirName, env)).toBe(expected);
    // A path starting with two separators is a network path on Windows.
    expect(listed.filter(d => /^[\\/]{2}/.test(d))).toEqual([]);
    if (!/^[A-Za-z]--/.test(dirName)) expect(listed).toEqual([]);
  });
});

describe('decodeProjectPath stays bounded', () => {
  it('a symlink loop cannot make the walk exponential', () => {
    // Every directory holds "a" and "a-a" pointing back at itself, as a symlink loop would.
    let listings = 0;
    const env: PathDecodeEnv = {
      platform: 'linux',
      listDirs: () => {
        listings++;
        return ['a', 'a-a'];
      },
    };
    const name = '-' + Array(40).fill('a').join('-') + '-zz';
    expect(decodeProjectPath(name, env)).toBe('/' + name.slice(1).split('-').join('/'));
    expect(listings).toBeLessThanOrEqual(256);
  });
});

describe('discoverSessions reports the directory Claude Code recorded', () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-cwd-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const guid = (n: number) => `workspace-0f8fad5b-d9cb-469f-a165-7086772895${String(n).padStart(2, '0')}`;
  const longProject = path.join('long', guid(1), guid(2), guid(3), guid(4), 'my-app');

  type Case = { name: string; sessionId: string; dirs: string[]; cwd: string };

  // The two sibling cases encode identically, so a decode that ignores what Claude Code
  // recorded must get one of them wrong whatever order readdir returns.
  const cases: Case[] = [
    { name: 'a project path over 200 encoded characters', sessionId: '11111111-0000-4000-8000-000000000001', dirs: [longProject], cwd: longProject },
    { name: 'a hyphenated project beside a spaced sibling', sessionId: '11111111-0000-4000-8000-000000000002', dirs: ['sib1/my-app', 'sib1/my app'], cwd: 'sib1/my-app' },
    { name: 'a spaced project beside a hyphenated sibling', sessionId: '11111111-0000-4000-8000-000000000003', dirs: ['sib2/my-app', 'sib2/my app'], cwd: 'sib2/my app' },
  ];

  // Writes one session into folder under a fresh HOME; returns the project discoverSessions reports.
  // An indexed session records its cwd only in sessions-index.json; a relocated one ends with a stamp.
  async function discoveredProject(sessionId: string, folder: string, cwd?: string, indexed = false, relocated?: string): Promise<string | undefined> {
    const home = path.join(root, `home-${sessionId}`);
    const projectDir = path.join(home, '.claude', 'projects', folder);
    fs.mkdirSync(projectDir, { recursive: true });
    const timestamp = '2026-11-01T00:00:00.000Z';
    const entry = {
      type: 'user', sessionId, cwd: indexed ? undefined : cwd, timestamp,
      message: { role: 'user', content: 'hello' },
    };
    const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
    const stamp = relocated ? JSON.stringify({ type: 'relocated', sessionId, relocatedCwd: relocated }) + '\n' : '';
    fs.writeFileSync(jsonlPath, JSON.stringify(entry) + '\n' + stamp);
    if (indexed) {
      const indexEntry = {
        sessionId, fullPath: jsonlPath, fileMtime: fs.statSync(jsonlPath).mtimeMs, firstPrompt: 'hello',
        messageCount: 1, created: timestamp, modified: timestamp, projectPath: cwd, isSidechain: false,
      };
      fs.writeFileSync(path.join(projectDir, 'sessions-index.json'), JSON.stringify({ version: 1, entries: [indexEntry] }));
    }

    const homedir = jest.spyOn(jest.requireActual<typeof os>('os'), 'homedir').mockReturnValue(home);
    try {
      const sessions = await discoverSessions();
      return sessions.find(s => s.session_id === sessionId)?.project;
    } finally {
      homedir.mockRestore();
    }
  }

  it.each(cases)('$name', async ({ sessionId, dirs, cwd }) => {
    for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
    const realCwd = path.join(root, cwd);
    expect(await discoveredProject(sessionId, claudeProjectFolder(realCwd), realCwd)).toBe(realCwd);
  });

  type FolderCase = { name: string; sessionId: string; folder: string; cwd?: string; indexed?: boolean; relocated?: string; expected: string };

  // Nothing under /absent exists, so decoding reads each '-' in the folder name as '/'.
  const folderCases: FolderCase[] = [
    { name: 'a cwd in a subdirectory of the project is ignored', sessionId: '22222222-0000-4000-8000-000000000001', folder: '-absent-proj', cwd: '/absent/proj/src', expected: '/absent/proj' },
    { name: 'a cwd in an unrelated directory is ignored', sessionId: '22222222-0000-4000-8000-000000000002', folder: '-absent-proj', cwd: '/absent/other', expected: '/absent/proj' },
    { name: 'a session with no cwd decodes the folder name', sessionId: '22222222-0000-4000-8000-000000000003', folder: '-absent-proj', expected: '/absent/proj' },
    { name: 'a Windows cwd that names the folder', sessionId: '22222222-0000-4000-8000-000000000004', folder: 'C--Users-first-last-src-my-proj', cwd: 'C:\\Users\\first.last\\src\\my-proj', expected: 'C:\\Users\\first.last\\src\\my-proj' },
    { name: 'an indexed session uses the cwd the index recorded', sessionId: '22222222-0000-4000-8000-000000000005', folder: '-absent-my-proj', cwd: '/absent/my-proj', indexed: true, expected: '/absent/my-proj' },
    { name: 'an indexed session ignores a subdirectory cwd', sessionId: '22222222-0000-4000-8000-000000000006', folder: '-absent-proj', cwd: '/absent/proj/src', indexed: true, expected: '/absent/proj' },
    { name: 'a relocated session uses the cwd it moved to', sessionId: '22222222-0000-4000-8000-000000000007', folder: '-absent-new-proj', cwd: '/absent/old-proj', relocated: '/absent/new-proj', expected: '/absent/new-proj' },
  ];

  it.each(folderCases)('$name', async ({ sessionId, folder, cwd, indexed, relocated, expected }) => {
    expect(await discoveredProject(sessionId, folder, cwd, indexed, relocated)).toBe(expected);
  });
});

describe('isProjectCwd', () => {
  const longCwd = '/work/' + 'deep/'.repeat(50) + 'my-app';
  const longFolder = claudeProjectFolder(longCwd);
  const longKept = encodeProjectPath(longCwd).slice(0, 200);

  type Case = { name: string; cwd: unknown; dirName: string; expected: boolean };

  const cases: Case[] = [
    { name: 'the cwd the folder was named for', cwd: '/Users/alice/my-app', dirName: '-Users-alice-my-app', expected: true },
    { name: 'a same-encoding sibling also names the folder', cwd: '/Users/alice/my app', dirName: '-Users-alice-my-app', expected: true },
    { name: 'a subdirectory of the project', cwd: '/Users/alice/my-app/src', dirName: '-Users-alice-my-app', expected: false },
    { name: 'an unrelated directory', cwd: '/tmp', dirName: '-Users-alice-my-app', expected: false },
    { name: 'a missing cwd', cwd: undefined, dirName: '-Users-alice-my-app', expected: false },
    { name: 'an empty cwd', cwd: '', dirName: '-Users-alice-my-app', expected: false },
    { name: 'a cwd that is not a string', cwd: 42, dirName: '-Users-alice-my-app', expected: false },
    { name: 'a Windows cwd the folder was named for', cwd: 'C:\\Users\\first.last\\src\\my-proj', dirName: 'C--Users-first-last-src-my-proj', expected: true },
    { name: 'a Windows cwd on another drive', cwd: 'D:\\Users\\first.last\\src\\my-proj', dirName: 'C--Users-first-last-src-my-proj', expected: false },
    { name: 'a Windows cwd in a subdirectory', cwd: 'C:\\Users\\first.last\\src\\my-proj\\lib', dirName: 'C--Users-first-last-src-my-proj', expected: false },
    { name: 'a long cwd the folder was named for', cwd: longCwd, dirName: longFolder, expected: true },
    { name: 'a long cwd with the kept prefix and another build\'s hash', cwd: longCwd, dirName: `${longKept}-1x2y3z`, expected: true },
    { name: 'a long cwd that differs within the first 200', cwd: longCwd.replace('/work/', '/play/'), dirName: longFolder, expected: false },
    { name: 'a long cwd against a cut name with no hash', cwd: longCwd, dirName: longKept, expected: false },
  ];

  it.each(cases)('$name', ({ cwd, dirName, expected }) => {
    expect(isProjectCwd(cwd, dirName)).toBe(expected);
  });
});

describe('discoverSessions reports the project when the session later works elsewhere', () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cwd-drift-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const guid = (n: number) => `workspace-0f8fad5b-d9cb-469f-a165-7086772895${String(n).padStart(2, '0')}`;
  const longParent = path.join('long', guid(1), guid(2), guid(3), guid(4));

  // The session starts in the project, then writes over 64 KB of entries from laterCwd,
  // as a long session does after Claude cds into a subdirectory or out of the project.
  type Case = { name: string; sessionId: string; project: string; laterCwd: string; exists: boolean };

  const cases: Case[] = [
    { name: 'a long project, later working in its subdirectory', sessionId: '44444444-0000-4000-8000-000000000001', project: path.join(longParent, 'my-app'), laterCwd: path.join(longParent, 'my-app', 'src'), exists: true },
    { name: 'a long project, later working in its parent', sessionId: '44444444-0000-4000-8000-000000000002', project: path.join(longParent, 'my-api'), laterCwd: longParent, exists: true },
    { name: 'a long project, later working outside it', sessionId: '44444444-0000-4000-8000-000000000003', project: path.join(longParent, 'my-web'), laterCwd: 'elsewhere', exists: true },
    { name: 'a deleted worktree, later working in its subdirectory', sessionId: '44444444-0000-4000-8000-000000000004', project: path.join('gone', 'orch-foundation'), laterCwd: path.join('gone', 'orch-foundation', 'cmdctrl-api'), exists: false },
  ];

  it.each(cases)('$name', async ({ sessionId, project, laterCwd, exists }) => {
    const realProject = path.join(root, project);
    if (exists) fs.mkdirSync(path.join(realProject, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'elsewhere'), { recursive: true });

    const home = path.join(root, `home-${sessionId}`);
    const projectDir = path.join(home, '.claude', 'projects', claudeProjectFolder(realProject));
    fs.mkdirSync(projectDir, { recursive: true });
    const timestamp = '2026-11-01T00:00:00.000Z';
    const lines = [JSON.stringify({ type: 'user', sessionId, cwd: realProject, timestamp, message: { role: 'user', content: 'start' } })];
    const text = 'x'.repeat(1000);
    for (let i = 0; i < 100; i++) {
      lines.push(JSON.stringify({ type: 'assistant', sessionId, cwd: path.join(root, laterCwd), timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } }));
    }
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const homedir = jest.spyOn(jest.requireActual<typeof os>('os'), 'homedir').mockReturnValue(home);
    try {
      const sessions = await discoverSessions();
      expect(sessions.find(s => s.session_id === sessionId)?.project).toBe(realProject);
    } finally {
      homedir.mockRestore();
    }
  });
});

describe('discoverSessions reports the recorded cwd for folders other Claude Code versions named', () => {
  let root: string;

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-versions-')));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  // 249 encoded characters; nothing under /absent exists, as for a deleted scratch workspace.
  const longCwd = '/absent/' + 'workspace-0f8fad5b-d9cb-469f-a165-708677289501/'.repeat(5) + 'my-app';
  const encoded = encodeProjectPath(longCwd);
  const imageData = 'A'.repeat(120000);

  type Case = { name: string; sessionId: string; folder: string; cwd: string; firstPromptImage?: boolean };

  const cases: Case[] = [
    // Claude Code 2.1.50's native (Bun) build: `typeof Bun<"u"?Bun.hash(A).toString(36):hMK(A)`.
    // Bun.hash(longCwd).toString(36) === '14nrhgwtq0yg1' (Bun 1.2.20).
    { name: 'a long folder named by the Bun build', sessionId: '55555555-0000-4000-8000-000000000001', folder: `${encoded.slice(0, 200)}-14nrhgwtq0yg1`, cwd: longCwd },
    // Claude Code 2.0.x never cut the name: `A.replace(/[^a-zA-Z0-9]/g,"-")`.
    { name: 'a long folder named before names were cut', sessionId: '55555555-0000-4000-8000-000000000002', folder: encoded, cwd: longCwd },
    // A pasted screenshot puts the first cwd past the 64 KB head: "message" precedes "cwd".
    { name: 'a deleted worktree whose first prompt carried an image', sessionId: '55555555-0000-4000-8000-000000000003', folder: '-absent-worktrees-orch-foundation', cwd: '/absent/worktrees/orch-foundation', firstPromptImage: true },
  ];

  async function discoveredProject(sessionId: string, folder: string, cwd: string, firstPromptImage?: boolean): Promise<string | undefined> {
    const home = path.join(root, `home-${sessionId}`);
    const projectDir = path.join(home, '.claude', 'projects', folder);
    fs.mkdirSync(projectDir, { recursive: true });
    const timestamp = '2026-11-01T00:00:00.000Z';
    const content = firstPromptImage
      ? [{ type: 'text', text: 'fix this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } }]
      : 'hello';
    const lines = [
      JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId }),
      JSON.stringify({ parentUuid: null, isSidechain: false, type: 'user', message: { role: 'user', content }, cwd, sessionId, timestamp }),
      JSON.stringify({ parentUuid: 'u1', isSidechain: false, type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cwd, sessionId, timestamp }),
    ];
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const homedir = jest.spyOn(jest.requireActual<typeof os>('os'), 'homedir').mockReturnValue(home);
    try {
      const sessions = await discoverSessions();
      return sessions.find(s => s.session_id === sessionId)?.project;
    } finally {
      homedir.mockRestore();
    }
  }

  it.each(cases)('$name', async ({ sessionId, folder, cwd, firstPromptImage }) => {
    expect(await discoveredProject(sessionId, folder, cwd, firstPromptImage)).toBe(cwd);
  });

  it('an existing long project whose first prompt carried an image', async () => {
    const guid = (n: number) => `workspace-0f8fad5b-d9cb-469f-a165-7086772895${String(n).padStart(2, '0')}`;
    const cwd = path.join(root, 'long', guid(1), guid(2), guid(3), guid(4), 'my-app');
    fs.mkdirSync(cwd, { recursive: true });
    const folder = claudeProjectFolder(cwd);
    expect(folder.length).toBeGreaterThan(200);
    expect(await discoveredProject('55555555-0000-4000-8000-000000000004', folder, cwd, true)).toBe(cwd);
  });
});
