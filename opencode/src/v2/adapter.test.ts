import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TRANSCRIPT_FILE } from '../adapter/opencode';
import { OpenCodeEvents } from '../events';
import { serverFor } from '../opencode-server';
import { waitFor } from '../testing/fake-opencode';
import { FakeOpenCodeV2, fixture, frames, PASSWORD } from '../testing/fake-opencode-v2';
import { APPROVE, DENY, TurnManager, type TurnHandle } from '../turns';
import { OpenCodeV2Adapter, parseStartup, serverEnv } from './adapter';
import type { V2Message } from './transcript';

const A = 'ses_e6b552f8effeFw7O2cQqQ1CroI';
const B = 'ses_e6b535aa4ffe2fk2IDPyoTGlVz';
const FAILED = 'ses_e6b4b2cdbffeF627S0tb7dgm9s';

const messages = (name: string, n?: number): V2Message[] => fixture<{ data: V2Message[] }>(`messages-${name}.json`).data.slice(0, n);
const sessionInfo = (name: string) => fixture(`session-${name}.json`).data;

let fake: FakeOpenCodeV2;
let adapter: OpenCodeV2Adapter;
let turns: TurnManager;
let events: OpenCodeEvents;
let tools: string[];

beforeEach(async () => {
  fake = new FakeOpenCodeV2();
  const url = await fake.start();
  adapter = new OpenCodeV2Adapter(url, PASSWORD);
  fake.sessions = ['ses-a', 'ses-b', 'ses-failed'].map(sessionInfo);
  tools = [];
  turns = new TurnManager(adapter, { tool: (_t, _c, line) => tools.push(line), finished: () => undefined });
  await new Promise<void>((resolve) => {
    events = new OpenCodeEvents(url, (e) => turns.handleEvent(e), () => { void turns.resync(); resolve(); }, adapter.eventFeed);
    events.start();
  });
  await waitFor(() => fake.streamCount === 1, 'event stream');
});

afterEach(async () => {
  events.stop();
  await fake.stop();
});

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

/** A captured stream split after the first frame of `type`: before, then the rest. */
function splitAt(stream: string, type: string): [string[], string[]] {
  const all = frames(stream);
  const at = all.findIndex((d) => JSON.parse(d).type === type) + 1;
  return [all.slice(0, at), all.slice(at)];
}

describe('every request to v2 carries the server password', () => {
  it('sends Basic auth on calls and the event stream', async () => {
    await adapter.listSessions(new Set());
    expect(fake.requests.length).toBeGreaterThan(1);
    expect(new Set(fake.requests.map((r) => r.auth))).toEqual(new Set([`Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`]));
    expect(fake.calls('GET', '/api/event')).toHaveLength(1);
  });

  it('gets nothing with the wrong password', async () => {
    const wrong = new OpenCodeV2Adapter(adapter.url, 'nope');
    await expect(wrong.listSessions(new Set())).resolves.toEqual([]);
    await expect(wrong.sessionDirectory(A)).rejects.toThrow('HTTP 401 – Unauthorized');
  });
});

describe('a v2 turn, start to finish', () => {
  it('finishes a plain turn with its reply only once v2 has run it', async () => {
    const task = recorder();
    await turns.send(A, task.handle, 'Reply with exactly the words: pickle ready');
    // An idle from before this turn began ends nothing.
    fake.emit(frames('turn-text.sse').find((d) => JSON.parse(d).type === 'session.execution.succeeded')!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(task.calls).toEqual([]);

    fake.transcripts.set(A, messages('ses-a', 3));
    fake.emit(...frames('turn-text.sse'));
    await waitFor(() => task.calls.length > 0, 'completion');
    expect(task.calls).toEqual([['complete', 'pickle ready']]);
  });

  it('runs a prompt, asks permission for its shell call, and finishes once allowed', async () => {
    fake.transcripts.set(A, messages('ses-a', 3));
    const [beforeAsk, afterAsk] = splitAt('turn-permission.sse', 'permission.asked');
    const task = recorder();
    await turns.send(A, task.handle, 'Use your shell tool to run: ls -la.');
    expect(fake.calls('POST', `/api/session/${A}/prompt`)[0].body).toEqual({ text: 'Use your shell tool to run: ls -la.' });

    fake.emit(...beforeAsk);
    await waitFor(() => task.calls.some((c) => c[0] === 'wait'), 'permission card');
    expect(task.calls).toEqual([['progress', 'Running', 'ls -la'], ['wait', 'Allow shell: ls -la?', [APPROVE, DENY]]]);
    expect(tools).toEqual(['Running ls -la']);

    const reply = recorder();
    await turns.send(A, reply.handle, APPROVE);
    expect(fake.calls('POST', `/api/session/${A}/permission/per_194ab25910014L925gKLcGuQNr/reply`)[0].body).toEqual({ decision: 'once' });

    fake.transcripts.set(A, messages('ses-a', 7));
    fake.emit(...afterAsk);
    await waitFor(() => reply.calls.length > 0, 'completion');
    expect(reply.calls).toEqual([['complete', 'It printed **4 entries**: `.`, `..`, `.git`, and `README.md` (plus a `total 8` summary line).']]);
    expect(turns.isBusy(A)).toBe(false);
  });

  it('sends a typed refusal to the model as the reason', async () => {
    const [beforeAsk] = splitAt('turn-permission.sse', 'permission.asked');
    await turns.send(A, recorder().handle, 'go');
    fake.emit(...beforeAsk);
    await waitFor(() => turns.askEntry(A) !== undefined, 'permission card');
    await turns.send(A, recorder().handle, 'Not now');
    expect(fake.calls('POST', `/api/session/${A}/permission/per_194ab25910014L925gKLcGuQNr/reply`)[0].body).toEqual({ decision: 'reject', message: 'Not now' });
  });

  it('answers the question tool\'s form with the option the user picked', async () => {
    const [beforeAsk, afterAsk] = splitAt('turn-question.sse', 'form.created');
    const task = recorder();
    await turns.send(A, task.handle, 'ask me');
    fake.emit(...beforeAsk);
    await waitFor(() => task.calls.length > 0, 'question card');
    expect(task.calls).toEqual([['wait', 'Which color do you prefer?', ['Red', 'Blue']]]);

    const reply = recorder();
    await turns.send(A, reply.handle, 'Blue');
    expect(fake.calls('POST', `/api/session/${A}/form/frm_194ab7ce4001ltcNOW3BpFoehJ/reply`)[0].body).toEqual({ answer: { q0: 'Blue' } });

    fake.transcripts.set(A, messages('ses-a', 11));
    fake.emit(...afterAsk);
    await waitFor(() => reply.calls.length > 0, 'completion');
    expect(reply.calls).toEqual([['complete', 'Blue']]);
  });

  it('asks a two-question form one card at a time and replies once with both', async () => {
    const [beforeAsk] = splitAt('turn-question-multi.sse', 'form.created');
    const task = recorder();
    await turns.send(B, task.handle, 'ask me two');
    fake.emit(...beforeAsk);
    await waitFor(() => task.calls.length > 0, 'first card');
    expect(task.calls).toEqual([['wait', 'Which fruit do you like?', ['Apple', 'Pear']]]);

    const second = recorder();
    await turns.send(B, second.handle, 'Banana actually');
    expect(second.calls).toEqual([['wait', 'Which toppings do you want?', ['Salt', 'Pepper', 'Lime']]]);
    expect(fake.calls('POST', `/api/session/${B}/form/frm_194b534840015pU1297JmhNxLP/reply`)).toHaveLength(0);

    await turns.send(B, recorder().handle, 'Salt, Lime');
    expect(fake.calls('POST', `/api/session/${B}/form/frm_194b534840015pU1297JmhNxLP/reply`)[0].body)
      .toEqual({ answer: { q0: 'Banana actually', q1: ['Salt', 'Lime'] } });
  });

  it('ends a failed turn on opencode\'s error', async () => {
    fake.transcripts.set(FAILED, messages('ses-failed'));
    const task = recorder();
    await turns.send(FAILED, task.handle, 'hi');
    fake.emit(...frames('turn-failed.sse'));
    await waitFor(() => task.calls.length > 0, 'failure');
    expect(task.calls).toEqual([['error', 'Model unavailable: opencode/no-such-model']]);
  });

  it('stops a turn by interrupting it, and ends the task once opencode records the stop', async () => {
    const [started] = splitAt('turn-interrupt.sse', 'session.execution.started');
    const task = recorder();
    await turns.send(B, task.handle, 'write an essay');
    fake.emit(...started);
    fake.transcripts.set(B, messages('ses-b', 8));

    await expect(turns.stop(B, 'task')).resolves.toBe(true);
    expect(fake.calls('POST', `/api/session/${B}/interrupt`)).toHaveLength(1);
    expect(task.calls).toEqual([['complete', '']]);
    expect(turns.isBusy(B)).toBe(false);
  });
});

describe('slash commands on v2', () => {
  it('runs a command opencode advertised, and shows it as typed rather than its expansion', async () => {
    adapter.setCommands(fixture('commands.json').data.concat([{ name: 'pickle' }]));
    await turns.send(B, recorder().handle, '/pickle brine');
    expect(fake.calls('POST', `/api/session/${B}/command`)[0].body).toEqual({ name: 'pickle', text: 'brine' });
    expect(fake.calls('POST', `/api/session/${B}/prompt`)).toHaveLength(0);

    fake.emit(...frames('turn-command.sse'));
    fake.transcripts.set(B, messages('ses-b', 11));
    await waitFor(() => !turns.isBusy(B), 'turn end');
    const { messages: page } = await adapter.getMessages(B, 50);
    expect(page.slice(-2).map((m) => m.content)).toEqual(['/pickle brine', 'PICKLE brine']);
  });

  it('still shows a command as typed after the daemon restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'oc-v2-commands-'));
    const file = join(dir, 'typed.json');
    try {
      const before = new OpenCodeV2Adapter(adapter.url, PASSWORD, file);
      before.setCommands([{ name: 'pickle' }]);
      await before.send(B, '/pickle brine', undefined, (err) => { throw err; });
      const enqueued = frames('turn-command.sse').find((d) => JSON.parse(d).type === 'session.inbox.enqueued')!;
      before.eventFeed.parse!(enqueued);

      fake.transcripts.set(B, messages('ses-b', 11));
      const after = new OpenCodeV2Adapter(adapter.url, PASSWORD, file);
      const { messages: page } = await after.getMessages(B, 50);
      expect(page.slice(-2).map((m) => m.content)).toEqual(['/pickle brine', 'PICKLE brine']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sends a slash word opencode never advertised as plain text', async () => {
    adapter.setCommands([{ name: 'review' }]);
    await turns.send(B, recorder().handle, '/tmp/notes.md is broken');
    expect(fake.calls('POST', `/api/session/${B}/prompt`)[0].body).toEqual({ text: '/tmp/notes.md is broken' });
  });

  it('compacts with v2\'s own compact', async () => {
    await turns.send(B, recorder().handle, '/compact');
    expect(fake.calls('POST', `/api/session/${B}/compact`)).toHaveLength(1);
  });

  it('lists commands for the session\'s project, then its skills', async () => {
    fake.commands = fixture('commands.json').data;
    fake.skills = [{ id: 'report', name: 'Report', description: 'Report an opencode issue' }, { id: 'review', name: 'Review' }];
    const listed = await adapter.listCommands('/work/repo');
    expect(listed.map((c) => [c.name, c.source])).toEqual([['init', undefined], ['review', undefined], ['goal', undefined], ['report', 'skill']]);
    expect(fake.calls('GET', '/api/command')[0].query.get('location[directory]')).toBe('/work/repo');
    expect(fake.calls('GET', '/api/skill')[0].query.get('location[directory]')).toBe('/work/repo');
  });

  it('runs a skill as an attachment to the prompt, and shows it as typed', async () => {
    adapter.setCommands([{ name: 'review' }, { name: 'report', source: 'skill' }]);
    await turns.send(B, recorder().handle, '/report the crash on save');
    expect(fake.calls('POST', `/api/session/${B}/prompt`)[0].body).toEqual({ text: 'the crash on save', skills: [{ id: 'report' }] });
    expect(fake.calls('POST', `/api/session/${B}/command`)).toHaveLength(0);

    const prompt = { id: 'msg_skill', type: 'user', time: { created: 1 }, text: 'the crash on save', skills: [{ id: 'report' }] };
    fake.transcripts.set(B, [prompt]);
    expect((await adapter.getMessages(B, 10)).messages.map((m) => m.content)).toEqual(['/report the crash on save']);
  });
});

describe('sessions on v2', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-v2-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('opens a session at the project\'s real path, which v2 needs to record changes', async () => {
    const link = join(dir, 'link');
    symlinkSync(tmpdir(), link);
    await adapter.createSession(link);
    await adapter.createSession('/no/such/project');
    expect(fake.calls('POST', '/api/session').map((r) => r.body)).toEqual([{ location: { directory: realpathSync(tmpdir()) } }, {}]);
  });

  it('lists top-level sessions from every project with their last words', async () => {
    fake.sessions = fixture('sessions.json').data;
    fake.transcripts.set(A, messages('ses-a'));
    const listed = await adapter.listSessions(new Set([B]));
    expect(fake.calls('GET', '/api/session')[0].query.get('parentID')).toBe('null');
    const a = listed.find((s) => s.session_id === A)!;
    expect(a).toMatchObject({ title: 'Pickle ready', project: '/tmp/feat119/proj', project_name: 'proj', last_message: 'done', is_active: false, file_path: TRANSCRIPT_FILE });
    expect(listed.some((s) => s.session_id === B)).toBe(false);
  });

  // The server resumes a session it is told has messages and starts a new one otherwise.
  it('counts a listed conversation as having messages', async () => {
    fake.sessions = fixture('sessions.json').data;
    fake.transcripts.set(A, messages('ses-a'));
    const listed = await adapter.listSessions(new Set([B]));
    expect(listed.find((s) => s.session_id === A)!.message_count).toBeGreaterThan(0);
  });

  it('reads a transcript longer than one page', async () => {
    const one = messages('ses-a', 2);
    const long: V2Message[] = Array.from({ length: 450 }, (_, i) => ({ ...one[i % 2], id: `msg_${String(i).padStart(4, '0')}` }));
    fake.transcripts.set(A, long);
    expect((await adapter.activity(A)).count).toBe(450);
  });

  it('shows each turn\'s changes, asking v2 only about turns that changed files', async () => {
    fake.transcripts.set(B, messages('ses-b'));
    fake.diffs.set(`${B} msg_194aca598001zdtpGe2JO876Wt`, fixture('diff-edit-turn.json').data);
    const diff = await adapter.diff(B);
    expect(fake.calls('GET', `/api/session/${B}/diff`)).toHaveLength(1);
    expect(diff).toEqual([{
      prompt: 'Without using the shell, append a line gamma to notes.md. Then say done.',
      timestamp: expect.any(String),
      files: [{ file: 'notes.md', status: 'modified', additions: 1, deletions: 0, patch: expect.stringContaining('+gamma') }],
    }]);
  });

  it('attaches images as file uris', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    await adapter.send(A, 'see this', [png], (err) => { throw err; });
    expect(fake.calls('POST', `/api/session/${A}/prompt`)[0].body).toEqual({ text: 'see this', files: [{ uri: png, name: 'image-1' }] });
  });
});

describe('catching up after the event stream drops', () => {
  it('keeps a phone turn running when the user ran a ! command while it worked', async () => {
    const task = recorder();
    await turns.send(A, task.handle, 'say hi');
    fake.emit(frames('turn-text.sse').find((d) => JSON.parse(d).type === 'session.execution.started')!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const now = Date.now();
    fake.transcripts.set(A, [
      { id: 'msg_prompt', type: 'user', time: { created: now }, text: 'say hi' },
      { id: 'msg_sh', type: 'shell', status: 'exited', time: { created: now, completed: now }, command: 'echo mid-turn', output: { output: 'mid-turn\n' } },
    ]);

    await turns.resync();
    expect(task.calls).toEqual([]);
    expect(turns.isBusy(A)).toBe(true);
  });

  it('shows a permission v2 raised while the stream was down, and can answer it', async () => {
    const asked = frames('turn-permission.sse').map((d) => JSON.parse(d)).find((f) => f.type === 'permission.asked');
    const task = recorder();
    await turns.send(A, task.handle, 'go');
    fake.emit(frames('turn-permission.sse').find((d) => JSON.parse(d).type === 'session.execution.started')!);
    await waitFor(() => turns.isBusy(A), 'busy');
    fake.transcripts.set(A, messages('ses-a', 5));
    fake.permissions = [asked.data];

    await turns.resync();
    expect(task.calls).toEqual([['wait', 'Allow shell: ls -la?', [APPROVE, DENY]]]);
    expect(fake.calls('GET', '/api/permission/request')[0].query.get('location[directory]')).toBe('/tmp/feat119/proj');

    await turns.send(A, recorder().handle, APPROVE);
    expect(fake.calls('POST', `/api/session/${A}/permission/per_194ab25910014L925gKLcGuQNr/reply`)).toHaveLength(1);
  });
});

describe('starting a v2 server without handing it a password to pass on', () => {
  const envCases: Array<{ name: string; env: NodeJS.ProcessEnv; want: NodeJS.ProcessEnv }> = [
    { name: 'drops the password v2 would read first', env: { PATH: '/bin', OPENCODE_PASSWORD: 'x' }, want: { PATH: '/bin' } },
    { name: 'drops the one it falls back to', env: { HOME: '/h', OPENCODE_SERVER_PASSWORD: 'y' }, want: { HOME: '/h' } },
    { name: 'keeps everything else', env: { PATH: '/bin', OPENCODE_CONFIG: '/c' }, want: { PATH: '/bin', OPENCODE_CONFIG: '/c' } },
  ];
  it.each(envCases)('$name', ({ env, want }) => {
    expect(serverEnv(env)).toEqual(want);
  });

  const startupCases: Array<{ name: string; output: string; want: { url?: string; password?: string } }> = [
    {
      name: 'both lines, as 2.2.5 prints them',
      output: 'server listening on http://127.0.0.1:64737\nserver password Tw7tdL9FRBPHdj8vcxtJEtmqV6eXuCAokvuLDUywkcg\n',
      want: { url: 'http://127.0.0.1:64737', password: 'Tw7tdL9FRBPHdj8vcxtJEtmqV6eXuCAokvuLDUywkcg' },
    },
    { name: 'listening, password not printed yet', output: 'server listening on http://127.0.0.1:64737\n', want: { url: 'http://127.0.0.1:64737' } },
    { name: 'a password line cut mid-chunk is not read until it ends', output: 'server listening on http://127.0.0.1:1\nserver password Tw7t', want: { url: 'http://127.0.0.1:1' } },
  ];
  it.each(startupCases)('$name', ({ output, want }) => {
    expect(parseStartup(output)).toEqual(want);
  });
});

describe('a daemon-started v2 server, wired the way start.ts wires it', () => {
  let home: string;
  let realHome: string | undefined;
  let started: ReturnType<typeof serverFor> | undefined;
  let stream: OpenCodeEvents | undefined;

  beforeEach(() => {
    // A stand-in `opencode` that announces the fake server and the password it "generated".
    home = mkdtempSync(join(tmpdir(), 'oc-v2-home-'));
    mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
    const bin = join(home, '.opencode', 'bin', 'opencode');
    writeFileSync(bin, `#!/bin/sh\nprintf 'server listening on ${adapter.url}\\nserver password ${PASSWORD}\\n'\nexec sleep 30\n`);
    chmodSync(bin, 0o755);
    realHome = process.env.HOME;
    process.env.HOME = home;
  });

  afterEach(() => {
    stream?.stop();
    started?.server.stopServer();
    process.env.HOME = realHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('authenticates its event stream with the password learned at start', async () => {
    started = serverFor('2.2.5');
    await started.server.startServer();
    expect(started.server.url).toBe(adapter.url);

    const before = fake.calls('GET', '/api/event').length;
    await new Promise<void>((resolve) => {
      stream = new OpenCodeEvents(started!.server.url, () => undefined, () => resolve(), started!.feed);
      stream.start();
    });
    const connect = fake.calls('GET', '/api/event')[before];
    expect(connect.auth).toBe(`Basic ${Buffer.from(`opencode:${PASSWORD}`).toString('base64')}`);
  });
});
