import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listReportedSessions, readMessages, resolveSessionPath } from './session-reader';
import { ompSessions, piSessions, useSessionSource, type SessionSource, type StoredSession } from './session-source';
import { header, message, titleSlot, writeSession } from './omp-session.fixture';

afterEach(() => useSessionSource(piSessions));

describe('reading omp sessions', () => {
  let root: string;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omp-reader-'));
    path = writeSession(root, '--work-proj--', '2026-11-01T17-40-06-437Z_s1', [
      titleSlot('Greeting'),
      header('s1', '/work/proj'),
      message('u1', 'user', 'hello omp', '2026-11-01T17:40:06.500Z'),
      message('a1', 'toolCall', ''),
      message('a2', 'assistant', 'hello back', '2026-11-01T17:40:07.000Z'),
    ]);
    useSessionSource(ompSessions(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cases: Array<{
    name: string;
    opts: { limit: number; beforeUuid?: string; afterUuid?: string };
    want: Array<[string, string]>;
  }> = [
    { name: 'user and assistant text, tool calls left out', opts: { limit: 50 }, want: [['USER', 'hello omp'], ['AGENT', 'hello back']] },
    { name: 'limit keeps the newest', opts: { limit: 1 }, want: [['AGENT', 'hello back']] },
    { name: 'after a uuid', opts: { limit: 50, afterUuid: 'u1' }, want: [['AGENT', 'hello back']] },
    { name: 'before a uuid', opts: { limit: 50, beforeUuid: 'a2' }, want: [['USER', 'hello omp']] },
  ];

  test.each(cases)('readMessages: $name', async ({ opts, want }) => {
    const { messages } = await readMessages('s1', opts);
    expect(messages.map(m => [m.role, m.content])).toEqual(want);
  });

  it('readMessages leaves the omp file untouched', async () => {
    const before = readFileSync(path);
    await readMessages('s1', { limit: 50 });
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('listReportedSessions reports the session under its omp title and path', async () => {
    const [s] = await listReportedSessions();
    expect(s).toMatchObject({
      session_id: 's1',
      title: 'Greeting',
      project: '/work/proj',
      project_name: 'proj',
      file_path: path,
      last_message: 'hello omp',
      message_count: 3,
    });
  });
});

describe('an omp session continued by a second process', () => {
  let root: string;
  let continuation: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omp-continued-'));
    writeSession(root, '--w--', 'orig', [titleSlot(), header('orig'), message('u1', 'user', 'start', '2026-11-01T10:00:00.000Z')]);
    // omp copies the transcript over and appends there from then on.
    continuation = writeSession(root, '--w--', 'cont', [
      titleSlot(), header('cont', '/work/proj', { continuationOf: 'orig', parentSession: 'orig' }),
      message('u1', 'user', 'start', '2026-11-01T10:00:00.000Z'),
      message('u2', 'user', 'from the phone', '2026-11-01T11:00:00.000Z'),
      message('a2', 'assistant', 'reply that went on', '2026-11-01T11:00:01.000Z'),
    ]);
    useSessionSource(ompSessions(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('resolves the original id to the continuation, so resume writes there', async () => {
    expect((await resolveSessionPath('orig', '/work/proj'))?.path).toBe(continuation);
  });

  it('reads the reply that went on under the original id', async () => {
    const { messages } = await readMessages('orig', { limit: 50 });
    expect(messages.map(m => m.content)).toEqual(['start', 'from the phone', 'reply that went on']);
  });

  it('lists the chain once, under the original id', async () => {
    expect((await listReportedSessions()).map(s => [s.session_id, s.file_path])).toEqual([['orig', continuation]]);
  });
});

describe('refute: the terminal goes on with the original after the phone continued it', () => {
  let root: string;
  let original: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omp-diverged-'));
    // The terminal held the session, so the phone's turn went to a continuation...
    writeSession(root, '--w--', 'cont', [
      titleSlot(), header('cont', '/work/proj', { continuationOf: 'orig', parentSession: 'orig' }),
      message('u1', 'user', 'start', '2026-11-01T10:00:00.000Z'),
      message('u2', 'user', 'from the phone', '2026-11-01T11:00:00.000Z'),
      message('a2', 'assistant', 'phone reply', '2026-11-01T11:00:01.000Z'),
    ]);
    // ...and the terminal, still running, kept writing its own file afterwards.
    original = writeSession(root, '--w--', 'orig', [
      titleSlot(), header('orig'),
      message('u1', 'user', 'start', '2026-11-01T10:00:00.000Z'),
      message('u3', 'user', 'typed in the terminal later', '2026-11-01T12:00:00.000Z'),
      message('a3', 'assistant', 'terminal reply', '2026-11-01T12:00:01.000Z'),
    ]);
    useSessionSource(ompSessions(root));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('shows the terminal turns under the original id', async () => {
    const { messages } = await readMessages('orig', { limit: 50 });
    expect(messages.map(m => m.content)).toContain('terminal reply');
  });

  it('resumes the copy omp itself resumes (the original, since both went on)', async () => {
    expect((await resolveSessionPath('orig', '/work/proj'))?.path).toBe(original);
  });

  it('reports the original\'s newest activity', async () => {
    const orig = (await listReportedSessions()).find(s => s.session_id === 'orig');
    expect(orig?.last_activity).toBe('2026-11-01T12:00:01.000Z');
  });
});

describe('resolveSessionPath', () => {
  const found: StoredSession = {
    id: 's1', path: '/sessions/--private-tmp-p--/s1.jsonl', cwd: '/private/tmp/p',
    firstMessage: 'hi', modified: new Date(0), messageCount: 1,
  };
  // Buckets by the canonical cwd, as both pi and omp do.
  const source: SessionSource = {
    agent: 'test',
    location: '/sessions',
    list: async (cwd?: string) => (cwd === undefined || cwd === '/private/tmp/p' ? [found] : []),
    entries: async () => [],
  };

  const cases: Array<{ name: string; id: string; cwd?: string; want?: string }> = [
    { name: 'finds it in the cwd bucket', id: 's1', cwd: '/private/tmp/p', want: found.path },
    { name: 'finds it with no cwd', id: 's1', want: found.path },
    { name: 'finds it when the cwd is a symlink to the project', id: 's1', cwd: '/tmp/p', want: found.path },
    { name: 'misses an unknown id', id: 'nope', cwd: '/private/tmp/p' },
  ];

  test.each(cases)('$name', async ({ id, cwd, want }) => {
    useSessionSource(source);
    expect((await resolveSessionPath(id, cwd))?.path).toBe(want);
  });
});
