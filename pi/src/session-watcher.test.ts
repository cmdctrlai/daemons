import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionWatcher, type AgentResponseEvent, type CompletionEvent, type VerboseEvent } from './session-watcher';
import { ompSessions, piSessions, useSessionSource } from './session-source';
import { header, message, titleSlot, writeSession } from './omp-session.fixture';

describe('SessionWatcher on an omp session', () => {
  let root: string;
  let path: string;
  let watcher: SessionWatcher;
  let responses: AgentResponseEvent[];
  let verbose: VerboseEvent[];
  let completions: CompletionEvent[];
  const tick = () => (watcher as any).tick() as Promise<void>;

  beforeEach(() => {
    jest.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'omp-watch-'));
    path = writeSession(root, '--w--', 's1', [titleSlot(), header('s1'), message('u1', 'user', 'hi')]);
    useSessionSource(ompSessions(root));
    responses = []; verbose = []; completions = [];
    watcher = new SessionWatcher({
      onAgentResponse: ev => responses.push(ev),
      onVerbose: ev => verbose.push(ev),
      onCompletion: ev => completions.push(ev),
    });
  });
  afterEach(() => {
    watcher.shutdown();
    useSessionSource(piSessions);
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    appended: string[];
    want: { responses: string[]; verbose: string[]; completions: number };
  }> = [
    { name: 'nothing new, nothing fired', appended: [], want: { responses: [], verbose: [], completions: 0 } },
    {
      name: 'a reply fires a response and a completion',
      appended: [message('a1', 'assistant', 'hello back')],
      want: { responses: ['hello back'], verbose: [], completions: 1 },
    },
    {
      name: 'a tool call alone is verbose, not a completion',
      appended: [message('a1', 'toolCall', '')],
      want: { responses: [], verbose: ['bash'], completions: 0 },
    },
  ];

  test.each(cases)('$name', async ({ appended, want }) => {
    watcher.watchSession('s1', path);
    await tick(); // primes on what is already there
    for (const line of appended) appendFileSync(path, line + '\n');
    await tick();
    expect({
      responses: responses.map(r => r.content),
      verbose: verbose.map(v => v.summary),
      completions: completions.length,
    }).toEqual(want);
  });

  it('never writes to the file it watches', async () => {
    const before = readFileSync(path);
    watcher.watchSession('s1', path);
    await tick();
    await tick();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('drops a read that finishes after the session was unwatched', async () => {
    watcher.watchSession('s1', path);
    await tick();
    appendFileSync(path, message('a1', 'assistant', 'late') + '\n');
    const pending = tick();
    watcher.unwatchSession('s1');
    await pending;
    expect(responses).toEqual([]);
  });
});

describe('SessionWatcher follows an omp session between its copies', () => {
  let root: string;
  let watcher: SessionWatcher;
  let responses: AgentResponseEvent[];
  let locates: number;
  const tick = () => (watcher as any).tick() as Promise<void>;
  const T = (m: number) => `2026-11-01T17:${String(m).padStart(2, '0')}:00.000Z`;
  const base = [message('u1', 'user', 'hi', T(1)), message('a1', 'assistant', 'hello', T(2))];
  const cont = () => [
    titleSlot(), header('C', '/work/proj', { continuationOf: 'X', parentSession: 'X' }), ...base,
    message('u2', 'user', 'from the phone', T(3)), message('a2', 'assistant', 'phone reply', T(4)),
  ];

  beforeEach(() => {
    jest.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'omp-follow-'));
    const source = ompSessions(root);
    locates = 0;
    useSessionSource({ ...source, locate: (id, p) => { locates++; return source.locate!(id, p); } });
    responses = [];
    watcher = new SessionWatcher({ onAgentResponse: ev => responses.push(ev) });
  });
  afterEach(() => {
    watcher.shutdown();
    useSessionSource(piSessions);
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  const cases: Array<{
    name: string;
    /** Writes after the watcher primed on X; each step is followed by a tick. */
    steps: Array<(xPath: string) => void>;
    want: string[];
  }> = [
    {
      name: 'a later turn in the continuation fires too',
      steps: [
        () => writeSession(root, '--w--', 'c', cont()),
        () => appendFileSync(join(root, '--w--', 'c.jsonl'), message('a3', 'assistant', 'terminal -p turn', T(6)) + '\n'),
      ],
      want: ['phone reply', 'terminal -p turn'],
    },
    {
      name: 'the original going on after the move brings the watcher back to it',
      steps: [
        () => writeSession(root, '--w--', 'c', cont()),
        x => appendFileSync(x, message('a5', 'assistant', 'terminal kept going', T(9)) + '\n'),
      ],
      want: ['phone reply', 'terminal kept going'],
    },
    {
      name: 'copied turns do not fire again when the session moves',
      steps: [() => writeSession(root, '--w--', 'c', cont())],
      want: ['phone reply'],
    },
  ];

  test.each(cases)('$name', async ({ steps, want }) => {
    const xPath = writeSession(root, '--w--', 'x', [titleSlot(), header('X'), ...base]);
    watcher.watchSession('X', xPath);
    await tick();
    for (const step of steps) {
      step(xPath);
      await tick();
    }
    expect(responses.map(r => [r.sessionId, r.content])).toEqual(want.map(c => ['X', c]));
  });

  it('notices a copy written to while it was being located', async () => {
    const xPath = writeSession(root, '--w--', 'x', [titleSlot(), header('X'), ...base]);
    writeSession(root, '--w--', 'c', cont());
    const source = ompSessions(root);
    let raced = false;
    useSessionSource({
      ...source,
      locate: async (id, p) => {
        const found = await source.locate!(id, p);
        if (!raced) {
          raced = true; // the terminal writes the original right after it was read
          appendFileSync(xPath, message('a5', 'assistant', 'written mid-locate', T(9)) + '\n');
        }
        return found;
      },
    });
    watcher.watchSession('X', xPath);
    await tick(); // primes on the continuation
    await tick();
    expect(responses.map(r => r.content)).toEqual(['written mid-locate']);
  });

  it('does not locate again while only the watched file or another session changes', async () => {
    const xPath = writeSession(root, '--w--', 'x', [titleSlot(), header('X'), ...base]);
    const other = writeSession(root, '--w--', 'other', [titleSlot(), header('O'), message('o1', 'user', 'busy', T(1))]);
    watcher.watchSession('X', xPath);
    await tick();
    const afterPrime = locates;
    appendFileSync(xPath, message('a2', 'assistant', 'more', T(5)) + '\n');
    appendFileSync(other, message('o2', 'assistant', 'unrelated', T(5)) + '\n');
    await tick();
    expect([afterPrime, locates, responses.map(r => r.content)]).toEqual([1, 1, ['more']]);
  });
});
