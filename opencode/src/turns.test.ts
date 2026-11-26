import { OpenCodeAdapter } from './adapter/opencode';
import { OpenCodeEvents } from './events';
import { FakeOpenCode, msg, waitFor } from './testing/fake-opencode';
import { APPROVE, continuedSession, DENY, describeTool, parseAnswer, TurnManager, type TurnHandle } from './turns';

const SID = 'ses_turn';
const DIR = '/work/alpha';

let fake: FakeOpenCode;
let adapter: OpenCodeAdapter;
let turns: TurnManager;
let events: OpenCodeEvents;
let tools: string[];
let finished: string[];

beforeEach(async () => {
  fake = new FakeOpenCode();
  const url = await fake.start();
  adapter = new OpenCodeAdapter(url);
  tools = [];
  finished = [];
  turns = new TurnManager(adapter, {
    tool: (_taskId, _callId, line) => tools.push(line),
    finished: (sessionId) => finished.push(sessionId),
  });
  adapter.busy = (directory) => turns.busyIn(directory);
  await new Promise<void>((resolve) => {
    events = new OpenCodeEvents(url, (e) => turns.handleEvent(e), () => { void turns.resync(); resolve(); });
    events.start();
  });
  await waitFor(() => fake.streamCount === 1, 'event stream');
  fake.transcripts.set(SID, [msg('m1', 'user', 'go'), msg('m2', 'assistant', 'all done')]);
  fake.sessionDirs.set(SID, DIR);
});

afterEach(async () => {
  events.stop();
  await fake.stop();
});

/** A task handle that records what the daemon told the app. */
function recorder(): { calls: unknown[][]; handle: TurnHandle } {
  const calls: unknown[][] = [];
  return {
    calls,
    handle: {
      taskId: 'task',
      progress: (action, target) => calls.push(['progress', action, target]),
      complete: (result) => calls.push(['complete', result]),
      waitForUser: (prompt, _result, options) => calls.push(['wait', prompt, options?.map((o) => o.label)]),
      error: (message) => calls.push(['error', message]),
    },
  };
}

const busy = () => fake.emit('session.status', { sessionID: SID, status: { type: 'busy' } }, DIR);
const idle = () => {
  fake.emit('session.status', { sessionID: SID, status: { type: 'idle' } }, DIR);
  fake.emit('session.idle', { sessionID: SID }, DIR);
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe('a turn runs on the event stream, not one long request', () => {
  it('starts with prompt_async and finishes only when opencode goes idle', async () => {
    const task = recorder();
    await turns.send(SID, task.handle, 'build it');

    expect(fake.calls('POST', `/session/${SID}/prompt_async`)).toHaveLength(1);
    expect(fake.calls('POST', `/session/${SID}/message`)).toHaveLength(0);
    busy();
    await settle();
    expect(task.calls).toEqual([]);
    expect(turns.isBusy(SID)).toBe(true);

    idle();
    await waitFor(() => task.calls.length > 0, 'completion');
    expect(task.calls).toEqual([['complete', 'all done']]);
    expect(finished).toEqual([SID]);
    expect(turns.isBusy(SID)).toBe(false);
  });

  it('finishes a slash command on idle even while its request is still open', async () => {
    adapter.setCommands([{ name: 'review' }]);
    fake.holdRoute(`POST /session/${SID}/command`);
    const task = recorder();
    await turns.send(SID, task.handle, '/review');
    await waitFor(() => fake.calls('POST', `/session/${SID}/command`).length === 1, 'command sent');

    busy();
    idle();
    await waitFor(() => task.calls.length > 0, 'completion');
    expect(task.calls).toEqual([['complete', 'all done']]);
  });

  it('ignores an idle that arrives before opencode picked the turn up', async () => {
    const task = recorder();
    await turns.send(SID, task.handle, 'next');
    idle();
    await settle();
    expect(task.calls).toEqual([]);
  });

  it('catches up on a turn that ended while the event stream was down', async () => {
    const task = recorder();
    await turns.send(SID, task.handle, 'go');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');
    await settle();
    fake.dropStreams();
    await waitFor(() => task.calls.length > 0, 'completion after reconnect');
    expect(task.calls).toEqual([['complete', 'all done']]);
  });
});

describe('permission requests reach the user', () => {
  const ask = () => fake.emit('permission.asked', {
    id: 'per_1', sessionID: SID, permission: 'bash', patterns: ['rm -rf build'], metadata: {}, always: [],
  }, DIR);

  it('asks with approve and deny, then answers opencode and finishes the turn', async () => {
    const first = recorder();
    await turns.send(SID, first.handle, 'clean up');
    busy();
    ask();
    await waitFor(() => first.calls.length > 0, 'question');
    expect(first.calls).toEqual([['wait', 'Allow bash: rm -rf build?', [APPROVE, DENY]]]);
    expect(turns.askEntry(SID)).toMatchObject({
      uuid: 'per_1:0', role: 'AGENT', question: { question: 'Allow bash: rm -rf build?', options: [{ label: APPROVE }, { label: DENY }] },
    });

    const second = recorder();
    await turns.send(SID, second.handle, APPROVE);
    const [reply] = fake.calls('POST', '/permission/per_1/reply');
    expect(reply.body).toEqual({ reply: 'once' });
    expect(reply.query.get('directory')).toBe(DIR);
    // The answer goes to the request, not to the model as a new message.
    expect(fake.calls('POST', `/session/${SID}/prompt_async`)).toHaveLength(1);
    expect(turns.askEntry(SID)).toBeUndefined();

    idle();
    await waitFor(() => second.calls.length > 0, 'completion');
    expect(second.calls).toEqual([['complete', 'all done']]);
  });

  const replies: Array<{ name: string; text: string; body: Record<string, string> }> = [
    { name: 'the approve button', text: APPROVE, body: { reply: 'once' } },
    { name: 'a typed yes', text: 'yes', body: { reply: 'once' } },
    { name: 'the deny button', text: DENY, body: { reply: 'reject' } },
    { name: 'anything else, passed on as the reason', text: 'use git clean instead', body: { reply: 'reject', message: 'use git clean instead' } },
  ];
  it.each(replies)('maps $name to opencode\'s reply', async ({ text, body }) => {
    await turns.send(SID, recorder().handle, 'clean up');
    busy();
    ask();
    await waitFor(() => !!turns.askEntry(SID), 'ask');
    await turns.send(SID, recorder().handle, text);
    expect(fake.calls('POST', '/permission/per_1/reply')[0].body).toEqual(body);
  });

  it('finds a request raised while the event stream was down', async () => {
    const task = recorder();
    await turns.send(SID, task.handle, 'clean up');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');
    fake.transcripts.set(SID, [msg('m1', 'user', 'clean up'), msg('m3', 'assistant', '', { finish: undefined, time: { created: 1 } })]);
    fake.permissions = [{ id: 'per_9', sessionID: SID, permission: 'edit', patterns: ['a.ts'] }];
    fake.dropStreams();
    await waitFor(() => task.calls.length > 0, 'question after reconnect');
    expect(task.calls).toEqual([['wait', 'Allow edit: a.ts?', [APPROVE, DENY]]]);
  });
});

describe('a subagent asks from its own child session', () => {
  const OTHER = 'ses_other';
  const CHILD = 'ses_child';
  const childAsk = () => fake.emit('permission.asked', {
    id: 'per_sub', sessionID: CHILD, permission: 'bash', patterns: ['make test'], metadata: {}, always: [],
  }, DIR);

  it('reaches the turn that started the subagent when two turns share the project', async () => {
    fake.sessionDirs.set(OTHER, DIR);
    fake.parents.set(CHILD, SID);
    const mine = recorder();
    const other = recorder();
    await turns.send(SID, mine.handle, 'delegate the tests');
    await turns.send(OTHER, other.handle, 'something else');
    childAsk();
    await waitFor(() => mine.calls.length > 0, 'card');
    expect(mine.calls).toEqual([['wait', 'Allow bash: make test?', [APPROVE, DENY]]]);
    expect(other.calls).toEqual([]);

    await turns.send(SID, recorder().handle, APPROVE);
    expect(fake.calls('POST', '/permission/per_sub/reply')[0].body).toEqual({ reply: 'once' });
  });

  it('is found after the event stream was down', async () => {
    fake.parents.set(CHILD, SID);
    const task = recorder();
    await turns.send(SID, task.handle, 'delegate the tests');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');
    fake.transcripts.set(SID, [msg('m1', 'user', 'delegate'), msg('m3', 'assistant', '', { finish: undefined, time: { created: 1 } })]);
    fake.permissions = [{ id: 'per_sub', sessionID: CHILD, permission: 'bash', patterns: ['make test'] }];
    fake.dropStreams();
    await waitFor(() => task.calls.length > 0, 'card after reconnect');
    expect(task.calls).toEqual([['wait', 'Allow bash: make test?', [APPROVE, DENY]]]);
  });
});

describe('questions reach the user', () => {
  const db = { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres' }, { label: 'SQLite' }] };
  const size = { question: 'How big?', header: 'Size', options: [{ label: 'Small' }, { label: 'Large' }] };

  it('shows the question with its options and sends the picked label back', async () => {
    const first = recorder();
    await turns.send(SID, first.handle, 'set up storage');
    busy();
    fake.emit('question.asked', { id: 'que_1', sessionID: SID, questions: [db] }, DIR);
    await waitFor(() => first.calls.length > 0, 'question');
    expect(first.calls).toEqual([['wait', 'Which database?', ['Postgres', 'SQLite']]]);
    expect(turns.askEntry(SID)?.question).toEqual({ question: 'Which database?', header: 'Database', options: db.options });

    await turns.send(SID, recorder().handle, 'SQLite');
    expect(fake.calls('POST', '/question/que_1/reply')[0].body).toEqual({ answers: [['SQLite']] });
  });

  it('asks several questions one at a time and answers them together', async () => {
    await turns.send(SID, recorder().handle, 'set up storage');
    busy();
    fake.emit('question.asked', { id: 'que_2', sessionID: SID, questions: [db, size] }, DIR);
    await waitFor(() => !!turns.askEntry(SID), 'first question');

    const second = recorder();
    await turns.send(SID, second.handle, 'Postgres');
    expect(second.calls).toEqual([['wait', 'How big?', ['Small', 'Large']]]);
    expect(fake.calls('POST', '/question/que_2/reply')).toHaveLength(0);

    await turns.send(SID, recorder().handle, 'Large');
    expect(fake.calls('POST', '/question/que_2/reply')[0].body).toEqual({ answers: [['Postgres'], ['Large']] });
  });

  const answers: Array<{ name: string; multiple: boolean; text: string; want: string[] }> = [
    { name: 'a single choice', multiple: false, text: 'SQLite', want: ['SQLite'] },
    { name: 'several choices the app joined', multiple: true, text: 'Postgres, SQLite', want: ['Postgres', 'SQLite'] },
    { name: 'a typed answer to a multi-select', multiple: true, text: 'neither', want: ['neither'] },
    { name: 'a typed answer', multiple: false, text: '  MySQL ', want: ['MySQL'] },
  ];
  it.each(answers)('parseAnswer: $name', ({ multiple, text, want }) => {
    expect(parseAnswer({ ...db, multiple }, text)).toEqual(want);
  });
});

describe('failures and retries are reported, not swallowed', () => {
  it('ends the turn on the provider error instead of an empty answer', async () => {
    fake.transcripts.set(SID, [msg('m1', 'user', 'hi')]);
    const task = recorder();
    await turns.send(SID, task.handle, 'hi');
    busy();
    fake.emit('session.error', { sessionID: SID, error: { name: 'UnknownError', data: { message: 'Model not found: x/y' } } }, DIR);
    idle();
    fake.emit('session.error', { sessionID: SID, error: { name: 'UnknownError', data: { message: 'stack trace' } } }, DIR);
    await waitFor(() => task.calls.length > 0, 'error');
    expect(task.calls).toEqual([['error', 'Model not found: x/y']]);
    expect(finished).toEqual([]);
  });

  it('reports an error the final message ended on', async () => {
    fake.transcripts.set(SID, [msg('m1', 'user', 'hi'), msg('m2', 'assistant', '', {
      error: { name: 'APIError', data: { message: 'Rate limit exceeded' } },
    })]);
    const task = recorder();
    await turns.send(SID, task.handle, 'hi');
    busy();
    idle();
    await waitFor(() => task.calls.length > 0, 'error');
    expect(task.calls).toEqual([['error', 'Rate limit exceeded']]);
  });

  it('shows a retry as progress', async () => {
    const task = recorder();
    await turns.send(SID, task.handle, 'hi');
    fake.emit('session.status', { sessionID: SID, status: { type: 'retry', attempt: 1, message: 'Provider overloaded', next: 0 } }, DIR);
    await waitFor(() => task.calls.length > 0, 'retry');
    expect(task.calls).toEqual([['progress', 'Retrying', 'Provider overloaded']]);
  });
});

describe('tool activity shows while the turn runs', () => {
  const tool = (callID: string, name: string, input: Record<string, unknown>, status = 'running') =>
    fake.emit('message.part.updated', { sessionID: SID, part: { type: 'tool', callID, tool: name, state: { status, input } }, time: 0 }, DIR);

  it('reports each tool call once, as progress and a verbose line', async () => {
    const task = recorder();
    await turns.send(SID, task.handle, 'test it');
    busy();
    tool('c1', 'bash', {}, 'pending');
    tool('c1', 'bash', { command: 'npm test' });
    tool('c1', 'bash', { command: 'npm test' });
    tool('c2', 'read', { filePath: 'src/a.ts' });
    await waitFor(() => task.calls.length === 2, 'progress');
    expect(task.calls).toEqual([['progress', 'Running', 'npm test'], ['progress', 'Reading', 'src/a.ts']]);
    expect(tools).toEqual(['Running npm test', 'Reading src/a.ts']);
  });

  const tools_: Array<{ tool: string; input: Record<string, unknown>; want: { action: string; target: string } }> = [
    { tool: 'bash', input: { command: 'ls' }, want: { action: 'Running', target: 'ls' } },
    { tool: 'edit', input: { filePath: '/a/b.ts' }, want: { action: 'Editing', target: '/a/b.ts' } },
    { tool: 'grep', input: { pattern: 'TODO' }, want: { action: 'Searching', target: 'TODO' } },
    { tool: 'webfetch', input: { url: 'https://x.dev' }, want: { action: 'Fetching', target: 'https://x.dev' } },
    { tool: 'mcp_thing', input: {}, want: { action: 'Using mcp_thing', target: '' } },
    { tool: 'bash', input: { command: 'x'.repeat(100) }, want: { action: 'Running', target: `${'x'.repeat(79)}…` } },
  ];
  it.each(tools_)('describeTool: $tool', ({ tool: name, input, want }) => {
    expect(describeTool(name, input)).toEqual(want);
  });
});

describe('a reply the server sends as a new task', () => {
  const created = new Set(['ses_mine']);
  const cases: Array<{ name: string; taskId: string; want: string | undefined }> = [
    { name: 'continues a session this daemon created', taskId: 'dev-1:opencode:ses_mine', want: 'ses_mine' },
    { name: 'starts fresh for a new task', taskId: 'dev-1:opencode:PENDING-1234', want: undefined },
    { name: 'starts fresh for a session it did not create', taskId: 'dev-1:opencode:ses_other', want: undefined },
  ];
  it.each(cases)('$name', ({ taskId, want }) => {
    expect(continuedSession(taskId, created)).toBe(want);
  });
});

describe('a turn waiting on the user', () => {
  it('blocks command reloads in its own project only', async () => {
    await turns.send(SID, recorder().handle, 'clean up');
    busy();
    fake.emit('permission.asked', { id: 'per_1', sessionID: SID, permission: 'bash', patterns: [], metadata: {}, always: [] }, DIR);
    await waitFor(() => !!turns.askEntry(SID), 'ask');

    expect(await adapter.reloadCommands(DIR)).toBeNull();
    expect(await adapter.reloadCommands('/work/beta')).toEqual([]);
    expect(fake.calls('POST', '/instance/dispose').map((r) => r.query.get('directory'))).toEqual(['/work/beta']);
  });
});

describe('the app keeps its place across a card', () => {
  it('pages on from an answered permission card to the turn\'s answer', async () => {
    await turns.send(SID, recorder().handle, 'clean up');
    busy();
    fake.emit('permission.asked', { id: 'per_1', sessionID: SID, permission: 'bash', patterns: [], metadata: {}, always: [] }, DIR);
    await waitFor(() => !!turns.askEntry(SID), 'ask');
    const card = turns.askEntry(SID)!;
    await turns.send(SID, recorder().handle, APPROVE);

    // The app's newest entry is the card; the transcript never holds it.
    fake.transcripts.set(SID, [
      msg('m1', 'user', 'clean up'),
      msg('m2', 'assistant', '', { finish: 'tool-calls' }),
      msg('m3', 'assistant', 'Cleaned.', { time: { created: Date.now() + 1000, completed: Date.now() + 1500 } }),
    ]);
    const next = await adapter.getMessages(SID, 50, undefined, card.uuid, turns.cardTime(card.uuid));
    expect(next.messages.map((m) => m.content)).toEqual(['Cleaned.']);
  });

  it('gives a question card the id the transcript files the answered question under', async () => {
    await turns.send(SID, recorder().handle, 'set up');
    busy();
    fake.emit('question.asked', {
      id: 'que_1', sessionID: SID, tool: { messageID: 'm2', callID: 'call_7' },
      questions: [{ question: 'Which?', header: 'H', options: [{ label: 'A' }] }],
    }, DIR);
    await waitFor(() => !!turns.askEntry(SID), 'ask');
    expect(turns.askEntry(SID)?.uuid).toBe('call_7:0:q');
    expect(turns.cardTime('call_7:0:q')).toEqual(expect.any(Number));
  });
});

describe('a turn that cannot start', () => {
  it('reports the failure and leaves no project busy', async () => {
    const task = recorder();
    await turns.send('ses_gone', task.handle, 'hello');
    expect(task.calls).toEqual([['error', expect.stringContaining('HTTP')]]);
    expect(turns.isBusy('ses_gone')).toBe(false);
    expect(turns.busyIn(DIR)).toBe(false);
  });
});

describe('stop', () => {
  const taskId = 'dev-1:opencode:PENDING-1';
  const named = (calls: unknown[][]) => calls.map((c) => c[0]);

  it('aborts the running turn in its project and ends the task without a completion push', async () => {
    const task = recorder();
    task.handle.taskId = taskId;
    await turns.send(SID, task.handle, 'run forever');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');

    expect(await turns.stop(SID, taskId)).toBe(true);
    const [abort] = fake.calls('POST', `/session/${SID}/abort`);
    expect(abort.query.get('directory')).toBe(DIR);
    expect(task.calls).toEqual([['complete', '']]);
    expect(finished).toEqual([]);
    expect(turns.isBusy(SID)).toBe(false);
  });

  it('finds the turn by the task while the app still holds a PENDING id', async () => {
    const task = recorder();
    task.handle.taskId = taskId;
    await turns.send(SID, task.handle, 'run forever');
    expect(await turns.stop('', taskId)).toBe(true);
    expect(fake.calls('POST', `/session/${SID}/abort`)).toHaveLength(1);
  });

  it('ends a turn that was waiting on the user', async () => {
    const task = recorder();
    task.handle.taskId = taskId;
    await turns.send(SID, task.handle, 'clean up');
    busy();
    fake.emit('permission.asked', { id: 'per_1', sessionID: SID, permission: 'bash', patterns: [], metadata: {}, always: [] }, DIR);
    await waitFor(() => !!turns.askEntry(SID), 'ask');

    expect(await turns.stop(SID, taskId)).toBe(true);
    expect(named(task.calls)).toEqual(['wait', 'complete']);
    expect(turns.askEntry(SID)).toBeUndefined();
  });

  it('ends the task only once the transcript shows the turn stopped', async () => {
    const prompt = msg('u1', 'user', 'run forever');
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { time: { created: 1 } })]);
    const task = recorder();
    task.handle.taskId = taskId;
    let transcriptAtEnd: unknown;
    task.handle.complete = () => { transcriptAtEnd = fake.transcripts.get(SID)?.at(-1)?.info.error; };
    await turns.send(SID, task.handle, 'run forever');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');
    setTimeout(() => fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { time: { created: 1 }, error: { name: 'MessageAbortedError' } })]), 300);

    // opencode reports idle while the abort is still being recorded.
    const stopping = turns.stop(SID, taskId);
    idle();
    expect(await stopping).toBe(true);
    expect(transcriptAtEnd).toEqual({ name: 'MessageAbortedError' });
    expect(task.calls).toEqual([]);
  });

  it('reports that nothing was running', async () => {
    expect(await turns.stop(SID, taskId)).toBe(false);
    expect(fake.calls('POST', `/session/${SID}/abort`)).toHaveLength(0);
  });
});

describe('a message sent while a stop is still in flight', () => {
  const taskId = 'dev-1:opencode:ses_turn';

  it('keeps the new turn running and does not end its task', async () => {
    const prompt = msg('u1', 'user', 'run forever');
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { time: { created: 1 } })]);
    const first = recorder();
    first.handle.taskId = taskId;
    await turns.send(SID, first.handle, 'run forever');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');
    setTimeout(() => fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { time: { created: 1 }, error: { name: 'MessageAbortedError' } })]), 300);

    // The user taps Stop, then sends a correction they had already typed.
    const stopping = turns.stop(SID, taskId);
    const second = recorder();
    second.handle.taskId = taskId;
    await turns.send(SID, second.handle, 'do X instead');
    expect(fake.calls('POST', `/session/${SID}/prompt_async`)).toHaveLength(2);
    await stopping;

    // The stop must not end the correction's task, or the server marks the session idle while it runs.
    expect({ second: second.calls, busy: turns.isBusy(SID) }).toEqual({ second: [], busy: true });
  });

  it('keeps the project busy, so the minute command reload cannot dispose the running correction', async () => {
    const prompt = msg('u1', 'user', 'run forever');
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { time: { created: 1 } })]);
    const first = recorder();
    first.handle.taskId = taskId;
    await turns.send(SID, first.handle, 'run forever');
    busy();
    await waitFor(() => turns.isBusy(SID), 'busy');
    setTimeout(() => fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { time: { created: 1 }, error: { name: 'MessageAbortedError' } })]), 300);

    const stopping = turns.stop(SID, taskId);
    await turns.send(SID, recorder().handle, 'do X instead');
    await stopping;

    expect(await adapter.reloadCommands(DIR)).toBeNull();
    expect(fake.calls('POST', '/instance/dispose')).toHaveLength(0);
  });
});
