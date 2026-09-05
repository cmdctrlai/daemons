import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isCodexCli, isMidTurn, isThreadId, lockPathFor } from './thread-lock';

describe('lockPathFor', () => {
  it('points at codex thread-writer-locks, named for the thread', () => {
    expect(lockPathFor('01a07276-a69c')).toBe(
      path.join(os.homedir(), '.codex', 'thread-writer-locks', '01a07276-a69c.lock')
    );
  });
});

describe('isCodexCli', () => {
  const cases: { name: string; command: string; want: boolean }[] = [
    {
      name: 'the CLI itself, by absolute path',
      command:
        '/Users/x/.npm-global/lib/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex',
      want: true,
    },
    {
      name: 'a bare name, which is argv[0] rather than an executable path',
      command: 'codex',
      want: false,
    },
    {
      name: 'a relative path, which cannot be checked for a bundle',
      command: './codex',
      want: false,
    },
    {
      name: 'the code-mode helper that ships beside it',
      command: '/opt/codex/bin/codex-code-mode-host',
      want: false,
    },
    {
      name: "the ChatGPT desktop app's framework helper",
      command: '/Applications/ChatGPT.app/Contents/Frameworks/browser_crashpad_handler',
      want: false,
    },
    {
      name: "the codex the ChatGPT desktop app bundles, whose basename is also codex",
      command: '/Applications/ChatGPT.app/Contents/Resources/codex',
      want: false,
    },
    {
      name: 'a codex inside any other app bundle',
      command: '/Users/x/Applications/Something.app/Contents/MacOS/codex',
      want: false,
    },
    { name: 'an unrelated process', command: '/bin/zsh', want: false },
    { name: 'a name that merely contains codex', command: '/usr/bin/mycodex', want: false },
    { name: 'empty', command: '', want: false },
  ];

  cases.forEach(({ name, command, want }) => {
    it(`${want ? 'accepts' : 'refuses'} ${name}`, () => {
      expect(isCodexCli(command)).toBe(want);
    });
  });
});

describe('isMidTurn', () => {
  let dir: string;
  let rollout: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-lock-'));
    rollout = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(rollout, '{}\n');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const cases: {
    name: string;
    ageMs: number | null;
    want: boolean;
  }[] = [
    { name: 'written just now', ageMs: 0, want: true },
    { name: 'written a second ago', ageMs: 1_000, want: true },
    { name: 'written just inside the window', ageMs: 9_000, want: true },
    { name: 'written just outside the window', ageMs: 11_000, want: false },
    { name: 'written an hour ago', ageMs: 60 * 60 * 1000, want: false },
    { name: 'no rollout on disk', ageMs: null, want: false },
  ];

  cases.forEach(({ name, ageMs, want }) => {
    it(`${want ? 'blocks' : 'allows'} a force quit when ${name}`, () => {
      if (ageMs === null) {
        expect(isMidTurn(path.join(dir, 'missing.jsonl'))).toBe(false);
        return;
      }
      const now = Date.now();
      const mtime = new Date(now - ageMs);
      fs.utimesSync(rollout, mtime, mtime);
      expect(isMidTurn(rollout, now)).toBe(want);
    });
  });

  it('allows a force quit when the session has no known rollout', () => {
    expect(isMidTurn(null)).toBe(false);
  });
});

describe('isThreadId', () => {
  const cases: { name: string; value: string; want: boolean }[] = [
    { name: 'a real codex thread id', value: '01a07276-a69c-7282-8e89-6bab77f2da3a', want: true },
    { name: 'uppercase hex', value: '01A07276-A69C-7282-8E89-6BAB77F2DA3A', want: true },
    { name: 'a parent-directory escape', value: '../../etc/passwd', want: false },
    { name: 'an absolute path', value: '/etc/passwd', want: false },
    { name: 'a traversal ending in a real id', value: '../01a07276-a69c-7282-8e89-6bab77f2da3a', want: false },
    { name: 'a slash anywhere', value: '01a07276-a69c-7282-8e89/6bab77f2da3a', want: false },
    { name: 'a pending placeholder', value: 'PENDING-abc123', want: false },
    { name: 'empty', value: '', want: false },
    { name: 'trailing newline', value: '01a07276-a69c-7282-8e89-6bab77f2da3a\n', want: false },
  ];

  cases.forEach(({ name, value, want }) => {
    it(`${want ? 'accepts' : 'refuses'} ${name}`, () => {
      expect(isThreadId(value)).toBe(want);
    });
  });
});

describe('isCodexCli excludes agent processes that are not terminal sessions', () => {
  // Both of these were on this machine holding real locks: one codex process
  // can be a desktop app or a plugin-installed app-server rather than a window
  // the user is sitting in front of.
  const home = os.homedir();
  const cases: { name: string; command: string; want: boolean }[] = [
    {
      name: "the ChatGPT desktop app's bundled codex",
      command: '/Applications/ChatGPT.app/Contents/Resources/codex',
      want: false,
    },
    {
      name: 'the app-server codex installs into its own plugin directory',
      command: path.join(home, '.codex', 'plugins', '.plugin-appserver', 'codex'),
      want: false,
    },
    {
      name: 'a terminal CLI from an npm install',
      command: path.join(home, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'vendor', 'bin', 'codex'),
      want: true,
    },
    {
      name: 'a terminal CLI from the shell installer',
      command: path.join(home, '.local', 'bin', 'codex'),
      want: true,
    },
  ];

  cases.forEach(({ name, command, want }) => {
    it(`${want ? 'accepts' : 'refuses'} ${name}`, () => {
      expect(isCodexCli(command)).toBe(want);
    });
  });
});
