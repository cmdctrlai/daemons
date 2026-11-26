import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { JsonRpcConnection, RpcRequestError } from './acp/connection';
import type { PermissionOption, ToolCallFields } from './acp/types';
import { parseCommandLine } from './command-line';
import { chooseOption, describeTool, permissionCard } from './present';
import { commandFor, startInstance } from './context';
import { continuedSession, projectDir, reportedSessions } from './sessions';
import { CLOSED_NOTE, TranscriptStore, pairReplies, type SessionRecord } from './transcript';
import { flush } from './testing/fake-agent';

describe('parseCommandLine', () => {
  const cases: Array<{ input: string; argv?: string[]; error?: RegExp }> = [
    { input: 'dsh acp', argv: ['dsh', 'acp'] },
    { input: '  qwen   --acp  ', argv: ['qwen', '--acp'] },
    { input: '"/Applications/My Agent/bin/agent" --acp', argv: ['/Applications/My Agent/bin/agent', '--acp'] },
    { input: "agent --name 'it''s'", argv: ['agent', '--name', 'its'] },
    { input: 'agent --say "a \\"quoted\\" word"', argv: ['agent', '--say', 'a "quoted" word'] },
    { input: 'agent with\\ space', argv: ['agent', 'with space'] },
    { input: 'agent ""', argv: ['agent', ''] },
    { input: 'agent $HOME; rm -rf /', argv: ['agent', '$HOME;', 'rm', '-rf', '/'] },
    { input: '', error: /empty/ },
    { input: 'agent "open', error: /Unterminated " quote/ },
  ];
  it.each(cases)('parses $input', ({ input, argv, error }) => {
    if (error) expect(() => parseCommandLine(input)).toThrow(error);
    else expect(parseCommandLine(input)).toEqual(argv);
  });
});

describe('describeTool', () => {
  const cases: Array<{ tool: ToolCallFields; action: string; target: string }> = [
    { tool: { toolCallId: '1', title: 'bash', kind: 'other', rawInput: { command: 'npm test' } }, action: 'Running', target: 'npm test' },
    { tool: { toolCallId: '1', title: 'Shell: ls -la (list)', kind: 'execute', rawInput: {} }, action: 'Running', target: 'Shell: ls -la (list)' },
    { tool: { toolCallId: '1', title: 'write', kind: 'other', rawInput: { file_path: '/w/a.ts', content: 'x' } }, action: 'Writing', target: '/w/a.ts' },
    { tool: { toolCallId: '1', title: 'Read file', kind: 'read', locations: [{ path: '/w/b.ts' }] }, action: 'Reading', target: '/w/b.ts' },
    { tool: { toolCallId: '1', title: 'mystery_tool', kind: 'other' }, action: 'Using mystery_tool', target: '' },
    { tool: { toolCallId: '1' }, action: 'Using a tool', target: '' },
    { tool: { toolCallId: '1', title: 'bash', rawInput: { command: `echo ${'x'.repeat(200)}` } }, action: 'Running', target: `echo ${'x'.repeat(74)}…` },
  ];
  it.each(cases)('describes $tool.title', ({ tool, action, target }) => {
    expect(describeTool(tool)).toEqual({ action, target });
  });
});

describe('permissionCard', () => {
  const options: PermissionOption[] = [
    { optionId: 'a', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'r', name: 'Reject', kind: 'reject_once' },
  ];
  const cases: Array<{ tool: ToolCallFields; question: string }> = [
    { tool: { toolCallId: '1', title: 'bash', rawInput: { command: 'rm x' } }, question: 'Allow: Running rm x?' },
    { tool: { toolCallId: '1', title: 'write', rawInput: { file_path: '/a', justification: 'Needed for the fix.' } }, question: 'Allow: Writing /a?\n\nNeeded for the fix.' },
    { tool: { toolCallId: '1' }, question: 'Allow: Using a tool?' },
  ];
  it.each(cases)('asks $question', ({ tool, question }) => {
    expect(permissionCard(tool, options)).toEqual({ question, header: 'Permission', options: [{ label: 'Allow once' }, { label: 'Reject' }] });
  });
});

describe('chooseOption', () => {
  const full: PermissionOption[] = [
    { optionId: 'once', name: 'Allow', kind: 'allow_once' },
    { optionId: 'always', name: 'Allow All Edits', kind: 'allow_always' },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' },
  ];
  const alwaysOnly: PermissionOption[] = [
    { optionId: 'always', name: 'Always', kind: 'allow_always' },
    { optionId: 'never', name: 'Never', kind: 'reject_always' },
  ];
  const cases: Array<{ options: PermissionOption[]; reply: string; id?: string }> = [
    { options: full, reply: 'Allow', id: 'once' },
    { options: full, reply: 'allow all edits', id: 'always' },
    { options: full, reply: '  REJECT ', id: 'no' },
    { options: full, reply: 'Yes!', id: 'once' },
    { options: full, reply: 'always', id: 'always' },
    { options: full, reply: 'n', id: 'no' },
    { options: alwaysOnly, reply: 'yes', id: 'always' },
    { options: alwaysOnly, reply: 'no', id: 'never' },
    { options: full, reply: 'try again later' },
    { options: full, reply: '' },
  ];
  it.each(cases)('maps "$reply"', ({ options, reply, id }) => {
    expect(chooseOption(options, reply)?.optionId).toBe(id);
  });
});

describe('TranscriptStore', () => {
  const entry = (i: number) => ({ uuid: `u${i}`, role: (i % 2 ? 'AGENT' : 'USER') as 'AGENT' | 'USER', content: `m${i}`, timestamp: new Date(1_000_000 + i).toISOString() });
  function filled(n: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-tx-'));
    const store = new TranscriptStore(dir);
    for (let i = 0; i < n; i++) store.append('s/1', '/w', entry(i));
    return { dir, store };
  }

  const pages: Array<{ name: string; limit: number; before?: string; after?: string; uuids: string[]; hasMore: boolean }> = [
    { name: 'newest page', limit: 3, uuids: ['u7', 'u8', 'u9'], hasMore: true },
    { name: 'everything', limit: 50, uuids: ['u0', 'u1', 'u2', 'u3', 'u4', 'u5', 'u6', 'u7', 'u8', 'u9'], hasMore: false },
    { name: 'before a cursor', limit: 2, before: 'u5', uuids: ['u3', 'u4'], hasMore: true },
    { name: 'before the first', limit: 5, before: 'u0', uuids: [], hasMore: false },
    { name: 'after a cursor', limit: 50, after: 'u7', uuids: ['u8', 'u9'], hasMore: false },
    { name: 'after the last', limit: 50, after: 'u9', uuids: [], hasMore: false },
    { name: 'unknown cursor', limit: 2, after: 'zzz', uuids: ['u8', 'u9'], hasMore: true },
    { name: 'zero limit', limit: 0, uuids: [], hasMore: true },
  ];
  it.each(pages)('pages: $name', ({ limit, before, after, uuids, hasMore }) => {
    const { store } = filled(10);
    const page = store.page('s/1', limit, before, after);
    expect(page.messages.map((m) => m.uuid)).toEqual(uuids);
    expect(page.hasMore).toBe(hasMore);
    expect(page.oldestUuid).toBe(uuids[0]);
    expect(page.newestUuid).toBe(uuids[uuids.length - 1]);
  });

  it('survives a restart, including ids with slashes', () => {
    const { dir } = filled(3);
    const reopened = new TranscriptStore(dir);
    expect(reopened.get('s/1')?.entries.map((e) => e.uuid)).toEqual(['u0', 'u1', 'u2']);
    expect(fs.readdirSync(dir)).toEqual(['s%2F1.json']);
  });

  it('skips files it cannot read', () => {
    const { dir } = filled(1);
    fs.writeFileSync(path.join(dir, 'torn.json'), '{"sessionId": "x", "entr');
    expect(new TranscriptStore(dir).list().map((r) => r.sessionId)).toEqual(['s/1']);
  });

  type Row = [string, 'USER' | 'AGENT', string];
  const replays: Array<{ name: string; record?: Array<Row | [...Row, 'card']>; replay: Row[]; want: string[] }> = [
    {
      name: "takes the agent's replay exactly, each shown message keeping its id and time",
      replay: [['r0', 'USER', 'm0 '], ['r1', 'AGENT', 'typed in the terminal'], ['r2', 'AGENT', 'm3'], ['r3', 'USER', 'm0']],
      want: ['u0 USER m0 ', 'u1 AGENT typed in the terminal', 'u3 AGENT m3', 'r3 USER m0'],
    },
    {
      name: 'a reply saved with fewer words than were shown keeps its id',
      replay: [['r0', 'USER', 'm0'], ['r1', 'AGENT', 'saved less'], ['r2', 'USER', 'm2'], ['r3', 'AGENT', 'm3']],
      want: ['u0 USER m0', 'u1 AGENT saved less', 'u2 USER m2', 'u3 AGENT m3'],
    },
    {
      name: 'a status line shown as its own message leaves the reply its id',
      record: [['u0', 'USER', 'go'], ['n1', 'AGENT', 'compressed'], ['n2', 'AGENT', 'reply']],
      replay: [['r0', 'USER', 'go'], ['r1', 'AGENT', 'reply']],
      want: ['u0 USER go', 'n2 AGENT reply'],
    },
    {
      name: "a card and its answer are passed over: the agent saved neither",
      record: [['u0', 'USER', 'go'], ['c1', 'AGENT', 'Allow?', 'card'], ['u2', 'USER', 'Allow'], ['n3', 'AGENT', 'notice reply']],
      replay: [['r0', 'USER', 'go'], ['r1', 'AGENT', 'reply']],
      want: ['u0 USER go', 'n3 AGENT reply'],
    },
    {
      name: 'a closed card is passed over',
      record: [['u0', 'USER', 'go'], ['c1', 'AGENT', `Allow?\n\n${CLOSED_NOTE}`]],
      replay: [['r0', 'USER', 'go'], ['r1', 'AGENT', 'reply']],
      want: ['u0 USER go', 'r1 AGENT reply'],
    },
    {
      name: "a reply to a prompt typed elsewhere takes no id of the daemon's",
      record: [['u0', 'USER', 'go'], ['n1', 'AGENT', 'cut short']],
      replay: [['r0', 'USER', 'go'], ['r1', 'USER', 'from the terminal'], ['r2', 'AGENT', 'terminal reply']],
      want: ['u0 USER go', 'r1 USER from the terminal', 'r2 AGENT terminal reply'],
    },
    {
      name: 'a message the agent never got does not end the turn before it',
      record: [['u0', 'USER', 'a'], ['n1', 'AGENT', 'x'], ['u2', 'USER', 'not sent'], ['u3', 'USER', 'b'], ['n4', 'AGENT', 'y']],
      replay: [['r0', 'USER', 'a'], ['r1', 'AGENT', 'x saved'], ['r2', 'USER', 'b'], ['r3', 'AGENT', 'y saved']],
      want: ['u0 USER a', 'n1 AGENT x saved', 'u3 USER b', 'n4 AGENT y saved'],
    },
    {
      name: 'what comes before any prompt pairs only with what came before one',
      record: [['u0', 'USER', 'a'], ['n1', 'AGENT', 'x']],
      replay: [['r0', 'AGENT', 'before'], ['r1', 'USER', 'b'], ['r2', 'AGENT', 'y']],
      want: ['r0 AGENT before', 'r1 USER b', 'r2 AGENT y'],
    },
    {
      name: 'drops what only the daemon held',
      replay: [['r0', 'USER', 'm0'], ['r1', 'AGENT', 'm1']],
      want: ['u0 USER m0', 'u1 AGENT m1'],
    },
    {
      name: 'an empty replay is an empty history',
      replay: [],
      want: [],
    },
    {
      name: 'a replay sharing nothing is taken whole',
      replay: [['r9', 'AGENT', 'something else']],
      want: ['r9 AGENT something else'],
    },
  ];
  it.each(replays)('$name', ({ record: rows, replay, want }) => {
    const { store } = filled(rows ? 0 : 4);
    for (const [uuid, role, content, card] of rows ?? []) {
      const question = card ? { question: content, options: [{ label: 'Allow' }] } : undefined;
      store.append('s/1', '/w', { uuid, role, content, timestamp: new Date(1_000_000).toISOString(), ...(question && { question }) });
    }
    store.setTitle('s/1', '/w', 'Agent title');
    store.applyReplay('s/1', '/w', replay.map(([uuid, role, content]) => ({ uuid, role, content, timestamp: 'later' })));
    const record = store.get('s/1')!;
    expect(record.entries.map((e) => `${e.uuid} ${e.role} ${e.content}`)).toEqual(want);
    expect(TranscriptStore.titleOf(record)).toBe('Agent title');
    if (want[0]?.startsWith('u0 ')) expect(record.entries[0].timestamp).toBe(entry(0).timestamp);
  });

  const replies: Array<{ name: string; mine: string[]; theirs: string[]; pairs: Array<[number, number]> }> = [
    { name: 'by words', mine: ['a', 'b'], theirs: ['a', 'b'], pairs: [[0, 0], [1, 1]] },
    { name: 'words before place', mine: ['notice', 'reply'], theirs: ['reply'], pairs: [[0, 1]] },
    { name: 'by place when no words match', mine: ['notice reply'], theirs: ['reply'], pairs: [[0, 0]] },
    { name: 'a leftover between pairs by words', mine: ['a', 'b cut', 'c'], theirs: ['a', 'b', 'c'], pairs: [[0, 0], [1, 1], [2, 2]] },
    { name: 'a leftover never reaches past a pair', mine: ['a', 'b', 'c'], theirs: ['c', 'x'], pairs: [[0, 2]] },
    { name: 'more saved than shown', mine: ['x'], theirs: ['p', 'q'], pairs: [[0, 0]] },
    { name: 'nothing shown', mine: [], theirs: ['p'], pairs: [] },
    { name: 'nothing saved', mine: ['x'], theirs: [], pairs: [] },
  ];
  it.each(replies)('pairs replies $name', ({ mine, theirs, pairs }) => {
    const agent = (content: string, i: number) => ({ uuid: `${i}`, role: 'AGENT' as const, content, timestamp: '' });
    expect(pairReplies(mine.map(agent), theirs.map(agent))).toEqual(pairs);
  });

  const titles: Array<{ record: Partial<SessionRecord>; title: string }> = [
    { record: { title: 'Named' }, title: 'Named' },
    { record: { entries: [{ uuid: 'a', role: 'USER', content: 'fix the\nbuild', timestamp: '' }] }, title: 'fix the' },
    { record: { entries: [{ uuid: 'a', role: 'USER', content: 'x'.repeat(100), timestamp: '' }] }, title: `${'x'.repeat(79)}…` },
    { record: { entries: [] }, title: '' },
  ];
  it.each(titles)('titles a session "$title"', ({ record, title }) => {
    expect(TranscriptStore.titleOf({ sessionId: 's', cwd: '/w', updatedAt: '', entries: [], ...record })).toBe(title);
  });
});

describe('reportedSessions', () => {
  const record = (id: string, updatedAt: string, extra: Partial<SessionRecord> = {}): SessionRecord => ({
    sessionId: id, cwd: '/home/u/proj', updatedAt,
    entries: [
      { uuid: '1', role: 'USER', content: 'first prompt', timestamp: updatedAt },
      { uuid: '2', role: 'AGENT', content: 'last answer', timestamp: updatedAt },
    ],
    ...extra,
  });

  it('merges recorded and listed sessions, newest first, marking busy ones', () => {
    const sessions = reportedSessions(
      [record('a', '2026-11-01T10:00:00Z'), record('b', '2026-11-01T09:00:00Z', { title: 'Own title' })],
      [
        { sessionId: 'b', cwd: '/elsewhere', title: 'Listed title', updatedAt: '2026-11-01T11:00:00Z' },
        { sessionId: 'c', cwd: '/x/other', title: null, updatedAt: null },
      ],
      (id) => id === 'a',
    );
    expect(sessions.map((s) => [s.session_id, s.title, s.project_name, s.message_count, s.is_active, s.last_activity])).toEqual([
      ['b', 'Own title', 'proj', 2, false, '2026-11-01T11:00:00Z'],
      ['a', 'first prompt', 'proj', 2, true, '2026-11-01T10:00:00Z'],
      ['c', 'c', 'other', 0, false, new Date(0).toISOString()],
    ]);
    expect(sessions[1].last_message).toBe('last answer');
  });
});

describe('commandFor', () => {
  const cases: Array<{ sub: string; instance?: string; text: string }> = [
    { sub: 'start', text: 'cmdctrl-acp start' },
    { sub: 'start', instance: 'qwen', text: 'cmdctrl-acp start --instance qwen' },
  ];
  it.each(cases)('$text', ({ sub, instance, text }) => {
    expect(commandFor(sub, instance)).toBe(text);
  });
});

describe('startInstance', () => {
  const cases: Array<{ name: string; flag?: string; env: Record<string, string>; instance?: string }> = [
    { name: 'the flag', flag: 'qwen', env: {}, instance: 'qwen' },
    { name: 'the flag over a recorded one', flag: 'qwen', env: { CMDCTRL_ACP_INSTANCE: 'dsh' }, instance: 'qwen' },
    { name: 'a recorded one after an auto-update respawn', env: { CMDCTRL_ACP_INSTANCE: 'qwen' }, instance: 'qwen' },
    { name: 'the default instance', env: { CMDCTRL_ACP_INSTANCE: '' }, instance: undefined },
  ];
  it.each(cases)('$name', ({ flag, env, instance }) => {
    expect(startInstance(flag, env)).toBe(instance);
  });
});

describe('continuedSession', () => {
  const cases: Array<{ taskId: string; native?: string }> = [
    { taskId: 'dev:acp:PENDING-123', native: undefined },
    { taskId: 'dev:acp:abc-123', native: 'abc-123' },
    { taskId: 'dev:acp:with:colons', native: 'with:colons' },
    { taskId: 'dev:acp:', native: undefined },
  ];
  it.each(cases)('$taskId', ({ taskId, native }) => {
    expect(continuedSession(taskId)).toBe(native);
  });
});

describe('projectDir', () => {
  it('uses home without a project, the real folder when it exists, and refuses a missing one', () => {
    expect(projectDir(undefined)).toBe(os.homedir());
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-proj-')));
    expect(projectDir(dir)).toBe(dir);
    // A symlinked path resolves to where it points, where the agent's own CLI files its sessions.
    const link = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-link-')), 'project');
    fs.symlinkSync(dir, link);
    expect(projectDir(link)).toBe(dir);
    expect(() => projectDir(path.join(dir, 'missing'))).toThrow('Project folder not found');
  });
});

describe('RpcRequestError', () => {
  const cases: Array<{ name: string; data: unknown; message: string }> = [
    { name: 'the detail Qwen Code gives', data: { details: '400 stub: bad request' }, message: 'Internal error: 400 stub: bad request' },
    { name: 'a detail given as text', data: 'rate limited, retry in 20s', message: 'Internal error: rate limited, retry in 20s' },
    { name: 'a detail given as a message', data: { message: 'invalid API key' }, message: 'Internal error: invalid API key' },
    { name: 'no detail', data: undefined, message: 'Internal error' },
    { name: 'a detail that repeats the message', data: { details: 'Internal error' }, message: 'Internal error' },
    { name: 'a detail of another shape', data: { code: 7 }, message: 'Internal error' },
  ];
  it.each(cases)('$name', ({ data, message }) => {
    expect(new RpcRequestError('session/prompt', { code: -32603, message: 'Internal error', data }).message).toBe(message);
  });
});

describe('JsonRpcConnection', () => {
  function pair(onRequest = async (_m: string, _p: unknown): Promise<unknown> => ({ ok: true })) {
    const toUs = new PassThrough();
    const fromUs = new PassThrough();
    const written: any[] = [];
    fromUs.setEncoding('utf-8');
    fromUs.on('data', (c: string) => c.split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
    const notes: unknown[] = [];
    const conn = new JsonRpcConnection(toUs, fromUs, onRequest, (m, p) => notes.push([m, p]));
    return { conn, toUs, written, notes };
  }

  it('matches responses to requests, across chunk boundaries', async () => {
    const { conn, toUs } = pair();
    const result = conn.request('session/new', {});
    toUs.write('{"jsonrpc":"2.0","id":1,"res');
    toUs.write('ult":{"sessionId":"s"}}\n');
    await expect(result).resolves.toEqual({ sessionId: 's' });
  });

  it('rejects with the error the agent sent', async () => {
    const { conn, toUs } = pair();
    const result = conn.request('session/prompt', {});
    toUs.write('{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Authentication required"}}\n');
    await expect(result).rejects.toEqual(expect.objectContaining({ message: 'Authentication required' }));
    await expect(result).rejects.toBeInstanceOf(RpcRequestError);
  });

  const requests: Array<{ name: string; handler: () => Promise<unknown>; reply: object }> = [
    { name: 'a result', handler: async () => ({ outcome: 'x' }), reply: { result: { outcome: 'x' } } },
    { name: 'a JSON-RPC error', handler: async () => { throw { code: -32601, message: 'nope' }; }, reply: { error: { code: -32601, message: 'nope' } } },
    { name: 'a thrown Error', handler: async () => { throw new Error('boom'); }, reply: { error: { code: -32603, message: 'boom' } } },
  ];
  it.each(requests)('answers an incoming request with $name, keeping its id', async ({ handler, reply }) => {
    const { toUs, written } = pair(handler);
    toUs.write('{"jsonrpc":"2.0","id":0,"method":"session/request_permission","params":{}}\n');
    await flush();
    expect(written).toEqual([{ jsonrpc: '2.0', id: 0, ...reply }]);
  });

  it('delivers notifications and survives a handler that throws', async () => {
    const toUs = new PassThrough();
    const notes: string[] = [];
    new JsonRpcConnection(toUs, new PassThrough(), async () => null, (m) => {
      notes.push(m);
      if (m === 'bad') throw new Error('handler bug');
    });
    toUs.write('{"jsonrpc":"2.0","method":"bad"}\n{"jsonrpc":"2.0","method":"good"}\n');
    await flush();
    expect(notes).toEqual(['bad', 'good']);
  });

  it('fails pending requests when the agent closes its output, and refuses new ones', async () => {
    const { conn, toUs } = pair();
    const result = conn.request('session/prompt', {});
    toUs.end();
    await expect(result).rejects.toThrow('closed its output');
    await expect(conn.request('x', {})).rejects.toThrow('not running');
  });
});
