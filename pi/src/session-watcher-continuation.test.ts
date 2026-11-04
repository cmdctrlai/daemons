import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionWatcher, type AgentResponseEvent } from './session-watcher';
import { ompSessions, piSessions, useSessionSource } from './session-source';
import { header, message, titleSlot, writeSession } from './omp-session.fixture';

// A watched omp session whose conversation moves to a continuation file (another
// omp process held it) keeps being watched at the old file, so the app sees none
// of the turns that land in the continuation – not the phone's own replies, not a
// terminal's – although the session list and history already fold them into it.
describe('refute r2: watcher follows an omp session into its continuation', () => {
  let root: string;
  let watcher: SessionWatcher;
  let responses: AgentResponseEvent[];
  const tick = () => (watcher as any).tick() as Promise<void>;

  beforeEach(() => {
    jest.useFakeTimers();
    root = mkdtempSync(join(tmpdir(), 'omp-watch-r2-'));
    useSessionSource(ompSessions(root));
    responses = [];
    watcher = new SessionWatcher({ onAgentResponse: ev => responses.push(ev) });
  });
  afterEach(() => {
    watcher.shutdown();
    useSessionSource(piSessions);
    jest.useRealTimers();
    rmSync(root, { recursive: true, force: true });
  });

  it('reports a reply written to the continuation under the watched session id', async () => {
    const original = [
      message('u1', 'user', 'hi', '2026-11-01T17:40:07.000Z'),
      message('a1', 'assistant', 'hello', '2026-11-01T17:40:08.000Z'),
    ];
    const xPath = writeSession(root, '--w--', 'x', [titleSlot(), header('X'), ...original]);
    watcher.watchSession('X', xPath);
    await tick(); // primes on what is already there

    writeSession(root, '--w--', 'c', [
      titleSlot(),
      header('C', '/work/proj', { continuationOf: 'X', parentSession: 'X' }),
      ...original,
      message('u2', 'user', 'from the phone', '2026-11-01T17:41:00.000Z'),
      message('a2', 'assistant', 'reply in continuation', '2026-11-01T17:41:01.000Z'),
    ]);
    // Same fold the history uses: the session id X now reads from the continuation.
    const listed = await ompSessions(root).list();
    expect(listed.map(s => s.id)).toEqual(['X']);
    expect(listed[0].path.endsWith('c.jsonl')).toBe(true);

    await tick();
    expect(responses.map(r => [r.sessionId, r.content])).toEqual([['X', 'reply in continuation']]);
  });
});
