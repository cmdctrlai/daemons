import { msg } from '../testing/fake-opencode';
import { diffTurns, page, STOPPED, toEntries, turnState, type Entry, type OpenCodeMessage } from './transcript';

const none = () => null;

describe('toEntries', () => {
  it('reads an answered question as the question with its options, then the answer', () => {
    const asked = msg('a1', 'assistant', 'One thing first.', {}, [{
      id: 'prt_q', type: 'tool', tool: 'question', callID: 'c1',
      state: {
        status: 'completed',
        input: { questions: [{ question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] },
        metadata: { answers: [['SQLite']] },
      },
    }]);

    expect(toEntries([msg('u1', 'user', 'set it up'), asked, msg('a2', 'assistant', 'Using SQLite.')], none)).toEqual([
      expect.objectContaining({ uuid: 'u1', role: 'USER', content: 'set it up' }),
      expect.objectContaining({ uuid: 'a1', role: 'AGENT', content: 'One thing first.' }),
      expect.objectContaining({
        uuid: 'c1:0:q', role: 'AGENT', content: 'Which database?',
        question: { question: 'Which database?', header: 'DB', options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
      }),
      expect.objectContaining({ uuid: 'c1:0:a', role: 'USER', content: 'SQLite' }),
      expect.objectContaining({ uuid: 'a2', role: 'AGENT', content: 'Using SQLite.' }),
    ]);
  });

  it('leaves a question still waiting to the live card', () => {
    const waiting = msg('a1', 'assistant', '', {}, [{
      type: 'tool', tool: 'question', callID: 'c1', state: { status: 'running', input: { questions: [] } },
    }]);
    expect(toEntries([waiting], none)).toEqual([]);
  });

  it('reads a compaction as the /compact the user ran', () => {
    const compaction: OpenCodeMessage = { info: { id: 'u2', role: 'user', time: { created: 1 } }, parts: [{ type: 'compaction' }] };
    expect(toEntries([compaction, msg('a3', 'assistant', '## Summary')], none).map((e) => [e.role, e.content])).toEqual([
      ['USER', '/compact'],
      ['AGENT', '## Summary'],
    ]);
  });
});

describe('page', () => {
  const entries: Entry[] = ['e1', 'e2', 'e3', 'e4', 'e5'].map((uuid, i) => ({
    uuid, role: 'AGENT', content: uuid, timestamp: new Date(1000 * (i + 1)).toISOString(),
  }));
  const ids = (r: { messages: Entry[] }) => r.messages.map((e) => e.uuid);

  const cases: Array<{ name: string; limit: number; before?: string; after?: string; afterTime?: number; want: string[]; more: boolean }> = [
    { name: 'newest page', limit: 2, want: ['e4', 'e5'], more: true },
    { name: 'everything fits', limit: 10, want: ['e1', 'e2', 'e3', 'e4', 'e5'], more: false },
    { name: 'Load More before the oldest shown', limit: 2, before: 'e4', want: ['e2', 'e3'], more: true },
    { name: 'Load More reaching the start', limit: 2, before: 'e2', want: ['e1'], more: false },
    { name: 'after an entry', limit: 2, after: 'e2', want: ['e3', 'e4'], more: true },
    { name: 'an entry no longer there', limit: 2, before: 'gone', want: [], more: false },
    { name: 'after a card raised between e3 and e4', limit: 5, after: 'card', afterTime: 3500, want: ['e4', 'e5'], more: false },
    { name: 'after a card raised before everything', limit: 5, after: 'card', afterTime: 500, want: ['e1', 'e2', 'e3', 'e4', 'e5'], more: false },
    { name: 'after a card with nothing newer', limit: 5, after: 'card', afterTime: 9000, want: [], more: false },
    { name: 'after an unknown entry with no card time', limit: 5, after: 'card', want: [], more: false },
  ];
  it.each(cases)('$name', ({ limit, before, after, afterTime, want, more }) => {
    const result = page(entries, limit, before, after, afterTime);
    expect(ids(result)).toEqual(want);
    expect(result.hasMore).toBe(more);
  });
});

describe('turnState', () => {
  const now = 1_700_000_100_000;
  const prompt = msg('u1', 'user', 'go', { time: { created: now - 1000 } });
  const cases: Array<{ name: string; messages: OpenCodeMessage[]; updated: number; finished: boolean; running: boolean }> = [
    { name: 'no messages', messages: [], updated: now, finished: false, running: false },
    { name: 'a prompt just sent', messages: [prompt], updated: now, finished: false, running: true },
    { name: 'a prompt nobody answered', messages: [msg('u1', 'user', 'go', { time: { created: now - 3 * 60_000 } })], updated: now, finished: false, running: false },
    { name: 'between tool steps', messages: [prompt, msg('a1', 'assistant', '', { finish: 'tool-calls', time: { created: now - 900, completed: now - 500 } })], updated: now, finished: false, running: true },
    { name: 'ended on tool calls the user denied', messages: [prompt, msg('a1', 'assistant', '', { finish: 'tool-calls', time: { created: now - 6000, completed: now - 5000 } })], updated: now, finished: false, running: false },
    { name: 'mid-answer', messages: [prompt, msg('a1', 'assistant', 'Wor', { finish: undefined, time: { created: now } })], updated: now, finished: false, running: true },
    { name: 'answered', messages: [prompt, msg('a1', 'assistant', 'Done')], updated: now, finished: true, running: false },
    { name: 'ended on an error', messages: [prompt, msg('a1', 'assistant', '', { finish: undefined, error: { name: 'APIError' } })], updated: now, finished: true, running: false },
    { name: 'abandoned mid-turn long ago', messages: [prompt, msg('a1', 'assistant', '', { finish: 'tool-calls' })], updated: now - 60 * 60_000, finished: false, running: false },
  ];
  it.each(cases)('$name', ({ messages, updated, finished, running }) => {
    const state = turnState(messages, updated, now);
    expect([state.finished, state.running]).toEqual([finished, running]);
  });

  it('previews the newest text', () => {
    const state = turnState([prompt, msg('a1', 'assistant', 'All tests pass.'), msg('a2', 'assistant', '', { finish: 'tool-calls' })], now, now);
    expect(state.preview).toBe('All tests pass.');
  });
});

describe('a stopped turn', () => {
  const aborted = msg('a1', 'assistant', 'Working on it', { finish: undefined, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } });

  it('reads as stopped after whatever the agent had said', () => {
    expect(toEntries([msg('u1', 'user', 'go'), aborted], none).map((e) => [e.role, e.content])).toEqual([
      ['USER', 'go'], ['AGENT', 'Working on it'], ['AGENT', STOPPED],
    ]);
  });

  it('finishes the turn as stopped', () => {
    expect(turnState([msg('u1', 'user', 'go'), aborted], 0)).toMatchObject({ finished: true, stopped: true });
    expect(turnState([msg('u1', 'user', 'go'), msg('a1', 'assistant', 'Done')], 0)).toMatchObject({ finished: true, stopped: false });
  });
});

describe('diffTurns', () => {
  const edit = (id: string, text: string, diffs: Array<Record<string, unknown>>, created: number): OpenCodeMessage => ({
    info: { id, role: 'user', time: { created }, summary: { diffs: diffs as never } },
    parts: [{ type: 'text', text }],
  });
  const readme = { file: 'README.md', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1,2 @@\n a\n+b\n' };
  const notes = { file: 'notes.txt', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+hello\n' };

  it('lists each turn\'s files under its prompt, newest first', () => {
    const turns = diffTurns([
      edit('u1', 'add notes', [notes], 1000),
      msg('a1', 'assistant', 'done'),
      edit('u2', 'just a question', [], 2000),
      edit('u3', 'touch the readme', [readme], 3000),
    ], none);
    expect(turns.map((t) => [t.prompt, t.files.map((f) => [f.file, f.status, f.additions, f.deletions])])).toEqual([
      ['touch the readme', [['README.md', 'modified', 1, 0]]],
      ['add notes', [['notes.txt', 'added', 1, 0]]],
    ]);
    expect(turns[1].files[0].patch).toBe(notes.patch);
  });

  it('cuts a huge patch at a line break', () => {
    const huge = { ...readme, patch: `${'+line\n'.repeat(20_000)}` };
    const [turn] = diffTurns([edit('u1', 'big', [huge], 1)], none);
    expect(turn.files[0].patch.length).toBeLessThan(50_100);
    expect(turn.files[0].patch.endsWith('… (diff cut short)')).toBe(true);
  });

  it('shows a command the user ran as the command', () => {
    const [turn] = diffTurns([edit('u1', 'long expanded template', [readme], 1)], (t) => (t.startsWith('long') ? '/review' : null));
    expect(turn.prompt).toBe('/review');
  });
});
