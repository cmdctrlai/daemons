import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { listOmpSessions, locateOmpSession, parseOmpSession, readOmpEntries } from './omp-sessions';
import { custom, header, message, titleSlot, writeSession } from './omp-session.fixture';

describe('parseOmpSession', () => {
  const cases: Array<{
    name: string;
    lines: string[];
    want: { id: string; cwd: string; title?: string; entryIds: string[] } | null;
  }> = [
    {
      name: 'reads past the title slot omp writes first',
      lines: [titleSlot(), header('s1'), message('m1', 'user', 'hi'), message('m2', 'assistant', 'hello')],
      want: { id: 's1', cwd: '/work/proj', entryIds: ['m1', 'm2'] },
    },
    {
      name: 'reads a legacy file that starts with the header',
      lines: [header('s2'), message('m1', 'user', 'hi')],
      want: { id: 's2', cwd: '/work/proj', entryIds: ['m1'] },
    },
    {
      name: 'takes the title from the slot',
      lines: [titleSlot('Fix the login bug'), header('s3')],
      want: { id: 's3', cwd: '/work/proj', title: 'Fix the login bug', entryIds: [] },
    },
    {
      name: 'falls back to the header title when the slot is blank',
      lines: [titleSlot(''), header('s4', '/w', { title: 'From header' })],
      want: { id: 's4', cwd: '/w', title: 'From header', entryIds: [] },
    },
    {
      name: 'skips a half-written last line',
      lines: [titleSlot(), header('s5'), message('m1', 'user', 'hi'), '{"type":"message","id":"m2","mess'],
      want: { id: 's5', cwd: '/work/proj', entryIds: ['m1'] },
    },
    {
      name: 'keeps non-message entries for the caller to filter',
      lines: [titleSlot(), header('s6'), message('m1', 'user', 'hi'), custom('c1')],
      want: { id: 's6', cwd: '/work/proj', entryIds: ['m1', 'c1'] },
    },
    {
      name: 'drops entries without an id',
      lines: [titleSlot(), header('s7'), JSON.stringify({ type: 'message', message: { role: 'user' } })],
      want: { id: 's7', cwd: '/work/proj', entryIds: [] },
    },
    { name: 'is not a session without a header', lines: [titleSlot('x'), message('m1', 'user', 'hi')], want: null },
    { name: 'is not a session when empty', lines: [], want: null },
  ];

  test.each(cases)('$name', ({ lines, want }) => {
    const parsed = parseOmpSession(lines.join('\n'));
    if (want === null) {
      expect(parsed).toBeNull();
      return;
    }
    expect(parsed).not.toBeNull();
    expect({
      id: parsed!.id,
      cwd: parsed!.cwd,
      ...(parsed!.title !== undefined ? { title: parsed!.title } : {}),
      entryIds: parsed!.entries.map(e => e.id),
    }).toEqual(want);
  });

  it('builds a title slot of exactly 256 bytes, as omp does', () => {
    expect(Buffer.byteLength(titleSlot('abc') + '\n')).toBe(256);
  });
});

describe('listOmpSessions', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omp-sessions-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns nothing for a missing root', async () => {
    expect(await listOmpSessions(join(root, 'absent'))).toEqual([]);
  });

  const cases: Array<{
    name: string;
    sessions: Array<{ bucket: string; file: string; lines: string[] }>;
    want: Array<{ id: string; cwd: string; name?: string; firstMessage: string; messageCount: number }>;
  }> = [
    {
      name: 'summarises every bucket, newest first',
      sessions: [
        { bucket: '--work-a--', file: 'a', lines: [titleSlot('Older'), header('a', '/work/a'), message('m1', 'user', 'first a', '2026-11-01T10:00:00.000Z')] },
        { bucket: '-tmp-b', file: 'b', lines: [titleSlot(), header('b', '/tmp/b'), message('m1', 'user', 'first b', '2026-11-01T11:00:00.000Z'), message('m2', 'toolCall', ''), message('m3', 'assistant', 'done', '2026-11-01T11:00:05.000Z')] },
      ],
      want: [
        { id: 'b', cwd: '/tmp/b', firstMessage: 'first b', messageCount: 3 },
        { id: 'a', cwd: '/work/a', name: 'Older', firstMessage: 'first a', messageCount: 1 },
      ],
    },
    {
      name: 'skips files that are not sessions',
      sessions: [
        { bucket: '--w--', file: 'good', lines: [titleSlot(), header('good'), message('m1', 'user', 'hi')] },
        { bucket: '--w--', file: 'junk', lines: ['not json at all'] },
      ],
      want: [{ id: 'good', cwd: '/work/proj', firstMessage: 'hi', messageCount: 1 }],
    },
    {
      name: 'marks a session with no text the way pi does',
      sessions: [{ bucket: '--w--', file: 'empty', lines: [titleSlot(), header('empty')] }],
      want: [{ id: 'empty', cwd: '/work/proj', firstMessage: '(no messages)', messageCount: 0 }],
    },
  ];

  test.each(cases)('$name', async ({ sessions, want }) => {
    for (const s of sessions) writeSession(root, s.bucket, s.file, s.lines);
    const got = await listOmpSessions(root);
    expect(got.map(({ id, cwd, name, firstMessage, messageCount }) => ({
      id, cwd, ...(name !== undefined ? { name } : {}), firstMessage, messageCount,
    }))).toEqual(want);
    for (const s of got) expect(s.path.startsWith(root)).toBe(true);
  });

  it('dates a session by its last message, not by the file', async () => {
    const path = writeSession(root, '--w--', 'dated', [titleSlot(), header('dated'), message('m1', 'user', 'hi', '2026-10-01T09:00:00.000Z')]);
    utimesSync(path, new Date('2030-01-01'), new Date('2030-01-01'));
    const [s] = await listOmpSessions(root);
    expect(s.modified.toISOString()).toBe('2026-10-01T09:00:00.000Z');
  });

  it('does not descend into a session artifact directory, where subagents write', async () => {
    writeSession(root, '--w--', 'parent', [titleSlot(), header('parent'), message('m1', 'user', 'hi')]);
    writeSession(join(root, '--w--'), 'parent', 'subagent', [titleSlot(), header('child'), message('m1', 'user', 'task')]);
    expect((await listOmpSessions(root)).map(s => s.id)).toEqual(['parent']);
  });
});

describe('readOmpEntries', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omp-entries-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('reads entries and leaves the file byte-for-byte untouched', async () => {
    const path = writeSession(root, '--w--', 's', [titleSlot('T'), header('s'), message('m1', 'user', 'hi')]);
    const before = readFileSync(path);
    expect((await readOmpEntries(path)).map(e => e.id)).toEqual(['m1']);
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('refuses a file with no header rather than guessing', async () => {
    const path = join(root, 'x.jsonl');
    writeFileSync(path, titleSlot() + '\n');
    await expect(readOmpEntries(path)).rejects.toThrow('no omp session header');
  });
});

describe('foldContinuations, as listOmpSessions applies it', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omp-fold-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const T = (h: number) => `2026-11-01T${String(h).padStart(2, '0')}:00:00.000Z`;
  const cont = (id: string, of: string) => header(id, '/work/proj', { continuationOf: of, parentSession: of });
  const evalState = (id: string, at: string) =>
    JSON.stringify({ type: 'custom_message', customType: 'eval-state-context', id, parentId: null, timestamp: at, content: 'x', display: false });

  const cases: Array<{
    name: string;
    files: Array<{ bucket?: string; file: string; lines: string[] }>;
    want: Array<[string, string]>; // [session id shown, file it reads and resumes]
  }> = [
    {
      name: 'a session with no continuation is itself',
      files: [{ file: 'a', lines: [titleSlot(), header('a'), message('u1', 'user', 'hi', T(10))] }],
      want: [['a', 'a']],
    },
    {
      name: 'a continuation that holds the newest turn is followed',
      files: [
        { file: 'orig', lines: [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10))] },
        { file: 'cont', lines: [titleSlot(), cont('cont', 'orig'), message('u1', 'user', 'start', T(10)), message('u2', 'user', 'phone', T(11))] },
      ],
      want: [['orig', 'cont']],
    },
    {
      name: 'diverged: the original stays itself and the continuation is its own session',
      files: [
        { file: 'orig', lines: [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10)), message('u3', 'user', 'terminal', T(12))] },
        { file: 'cont', lines: [titleSlot(), cont('cont', 'orig'), message('u1', 'user', 'start', T(10)), message('u2', 'user', 'phone', T(11))] },
      ],
      want: [['orig', 'orig'], ['cont', 'cont']],
    },
    {
      name: 'a chain is followed to its newest copy',
      files: [
        { file: 'a', lines: [titleSlot(), header('a'), message('u1', 'user', '1', T(10))] },
        { file: 'b', lines: [titleSlot(), cont('b', 'a'), message('u1', 'user', '1', T(10)), message('u2', 'user', '2', T(11))] },
        { file: 'c', lines: [titleSlot(), cont('c', 'b'), message('u1', 'user', '1', T(10)), message('u2', 'user', '2', T(11)), message('u3', 'user', '3', T(12))] },
      ],
      want: [['a', 'c']],
    },
    {
      name: 'two copies of one session: the newer is resumed, the other keeps its own entry',
      files: [
        { file: 'orig', lines: [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10))] },
        { file: 'c1', lines: [titleSlot(), cont('c1', 'orig'), message('u1', 'user', 'start', T(10)), message('x1', 'user', 'one', T(11))] },
        { file: 'c2', lines: [titleSlot(), cont('c2', 'orig'), message('u1', 'user', 'start', T(10)), message('y1', 'user', 'two', T(12))] },
      ],
      want: [['orig', 'c2'], ['c1', 'c1']],
    },
    {
      name: 'a tie keeps the original, and a copy that adds nothing is not shown',
      files: [
        { file: 'orig', lines: [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10))] },
        { file: 'cont', lines: [titleSlot(), cont('cont', 'orig'), message('u1', 'user', 'start', T(10))] },
      ],
      want: [['orig', 'orig']],
    },
    {
      name: 'a continuation in another directory is not followed',
      files: [
        { bucket: '--a--', file: 'orig', lines: [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10))] },
        { bucket: '--b--', file: 'cont', lines: [titleSlot(), cont('cont', 'orig'), message('u1', 'user', 'start', T(10)), message('u2', 'user', 'more', T(11))] },
      ],
      want: [['cont', 'cont'], ['orig', 'orig']],
    },
    {
      name: 'a continuation whose original is gone is itself',
      files: [{ file: 'orphan', lines: [titleSlot(), cont('orphan', 'deleted'), message('u1', 'user', 'hi', T(10))] }],
      want: [['orphan', 'orphan']],
    },
    {
      name: 'entries that do not move the conversation are not its newest turn',
      files: [
        { file: 'orig', lines: [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10)), evalState('e1', T(13)), custom('x1')] },
        { file: 'cont', lines: [titleSlot(), cont('cont', 'orig'), message('u1', 'user', 'start', T(10)), message('u2', 'user', 'phone', T(11))] },
      ],
      want: [['orig', 'cont']],
    },
  ];

  test.each(cases)('$name', async ({ files, want }) => {
    for (const f of files) writeSession(root, f.bucket ?? '--w--', f.file, f.lines);
    const got = await listOmpSessions(root);
    expect(got.map(s => [s.id, basename(s.path, '.jsonl')])).toEqual(want);
  });

  const named = (title: string, id: string, extra: Record<string, unknown> = {}) =>
    [titleSlot(title), header(id, '/work/proj', { title, titleSource: 'auto', ...extra })];
  const titleCases: Array<{
    name: string;
    files: Array<{ file: string; lines: string[] }>;
    want: Array<[string, string | undefined]>; // [id, name]
  }> = [
    {
      name: 'a diverged continuation drops the title it carried over',
      files: [
        { file: 'orig', lines: [...named('Terminal Work', 'orig'), message('u1', 'user', 'a', T(10)), message('u3', 'user', 't', T(12))] },
        { file: 'cont', lines: [...named('Terminal Work', 'cont', { continuationOf: 'orig' }), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'p', T(11))] },
      ],
      want: [['orig', 'Terminal Work'], ['cont', undefined]],
    },
    {
      name: 'a diverged continuation keeps a title of its own',
      files: [
        { file: 'orig', lines: [...named('Terminal Work', 'orig'), message('u1', 'user', 'a', T(10)), message('u3', 'user', 't', T(12))] },
        { file: 'cont', lines: [...named('Phone Work', 'cont', { continuationOf: 'orig' }), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'p', T(11))] },
      ],
      want: [['orig', 'Terminal Work'], ['cont', 'Phone Work']],
    },
    {
      name: 'a followed continuation keeps the shared title under the original id',
      files: [
        { file: 'orig', lines: [...named('Terminal Work', 'orig'), message('u1', 'user', 'a', T(10))] },
        { file: 'cont', lines: [...named('Terminal Work', 'cont', { continuationOf: 'orig' }), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'p', T(11))] },
      ],
      want: [['orig', 'Terminal Work']],
    },
  ];

  test.each(titleCases)('$name', async ({ files, want }) => {
    for (const f of files) writeSession(root, '--w--', f.file, f.lines);
    expect((await listOmpSessions(root)).map(s => [s.id, s.name])).toEqual(want);
  });

  it('previews a continuation shown on its own by its first turn the original lacks', async () => {
    writeSession(root, '--w--', 'orig', [titleSlot(), header('orig'), message('u1', 'user', 'start', T(10)), message('u3', 'user', 'terminal', T(12))]);
    writeSession(root, '--w--', 'cont', [titleSlot(), cont('cont', 'orig'), message('u1', 'user', 'start', T(10)), message('u2', 'user', 'from the phone', T(11))]);
    const got = await listOmpSessions(root);
    expect(got.map(s => [s.id, s.firstMessage])).toEqual([['orig', 'start'], ['cont', 'from the phone']]);
  });

  it('keeps the original preview and takes the resumed copy\'s title', async () => {
    writeSession(root, '--w--', 'orig', [titleSlot('Old title'), header('orig'), message('u1', 'user', 'start', T(10))]);
    writeSession(root, '--w--', 'cont', [titleSlot('New title'), cont('cont', 'orig'), message('u1', 'user', 'start', T(10)), message('u2', 'user', 'phone', T(11))]);
    const [got] = await listOmpSessions(root);
    expect([got.firstMessage, got.name, got.messageCount]).toEqual(['start', 'New title', 2]);
  });
});

describe('locateOmpSession', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'omp-locate-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const T = (h: number) => `2026-11-01T${String(h).padStart(2, '0')}:00:00.000Z`;
  const cont = (id: string, of: string) => header(id, '/work/proj', { continuationOf: of, parentSession: of });
  const cases: Array<{
    name: string;
    files: Array<{ file: string; lines: string[] }>;
    id: string;
    want: { path: string; copies: string[] } | undefined;
  }> = [
    {
      name: 'a session with no copies reads from itself',
      files: [{ file: 'x', lines: [titleSlot(), header('X'), message('u1', 'user', 'a', T(10))] }],
      id: 'X', want: { path: 'x', copies: ['x'] },
    },
    {
      name: 'a followed continuation is where it reads from',
      files: [
        { file: 'x', lines: [titleSlot(), header('X'), message('u1', 'user', 'a', T(10))] },
        { file: 'c', lines: [titleSlot(), cont('C', 'X'), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'b', T(11))] },
      ],
      id: 'X', want: { path: 'c', copies: ['x', 'c'] },
    },
    {
      name: 'diverged: back on the original, the continuation no longer a copy',
      files: [
        { file: 'x', lines: [titleSlot(), header('X'), message('u1', 'user', 'a', T(10)), message('u3', 'user', 't', T(12))] },
        { file: 'c', lines: [titleSlot(), cont('C', 'X'), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'b', T(11))] },
      ],
      id: 'X', want: { path: 'x', copies: ['x'] },
    },
    {
      name: 'a chain to its newest copy, ignoring other sessions',
      files: [
        { file: 'x', lines: [titleSlot(), header('X'), message('u1', 'user', 'a', T(10))] },
        { file: 'c', lines: [titleSlot(), cont('C', 'X'), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'b', T(11))] },
        { file: 'd', lines: [titleSlot(), cont('D', 'C'), message('u1', 'user', 'a', T(10)), message('u2', 'user', 'b', T(11)), message('u3', 'user', 'c', T(12))] },
        { file: 'o', lines: [titleSlot(), header('O'), message('o1', 'user', 'other', T(13))] },
      ],
      id: 'X', want: { path: 'd', copies: ['x', 'c', 'd'] },
    },
    {
      name: 'an id that is not in the directory',
      files: [{ file: 'x', lines: [titleSlot(), header('X')] }],
      id: 'nope', want: undefined,
    },
  ];

  test.each(cases)('$name', async ({ files, id, want }) => {
    for (const f of files) writeSession(root, '--w--', f.file, f.lines);
    const got = await locateOmpSession(id, join(root, '--w--'));
    const name = (p: string) => basename(p, '.jsonl');
    expect(got && { path: name(got.path), copies: got.copies.map(c => name(c.path)) }).toEqual(want);
    for (const c of got?.copies ?? []) expect(c.size).toBe(statSync(c.path).size);
  });
});
