import { AcpAgent, type AgentListener } from './agent';
import { FakeAgentProcess, INIT_OK, flush, type Handler } from './testing/fake-agent';

function listener(overrides: Partial<AgentListener> = {}): AgentListener & { updates: any[]; exits: Error[]; withdrawn: unknown[] } {
  const updates: any[] = [];
  const exits: Error[] = [];
  const withdrawn: unknown[] = [];
  return {
    updates, exits, withdrawn,
    update: (n) => updates.push(n),
    permission: async () => ({ outcome: 'cancelled' }),
    requestWithdrawn: (id) => withdrawn.push(id),
    exited: (reason) => exits.push(reason),
    ...overrides,
  };
}

function agentWith(handlers: Record<string, Handler>, l = listener()) {
  const procs: FakeAgentProcess[] = [];
  const agent = new AcpAgent(['fake-acp', '--acp'], l, '0.0.0-test', () => undefined, () => {
    const p = new FakeAgentProcess(handlers);
    procs.push(p);
    return p.asChild();
  });
  return { agent, procs, l };
}

describe('AcpAgent.start', () => {
  const cases: Array<{ name: string; init: Handler; error?: RegExp }> = [
    { name: 'completes the handshake', init: INIT_OK({ loadSession: true }) },
    { name: 'refuses another protocol version', init: () => ({ protocolVersion: 2 }), error: /speaks ACP version 2/ },
    { name: 'surfaces a failed initialize', init: () => { throw new Error('needs login'); }, error: /needs login/ },
  ];
  it.each(cases)('$name', async ({ init, error }) => {
    const { agent, procs } = agentWith({ initialize: init });
    if (error) {
      await expect(agent.start()).rejects.toThrow(error);
      expect(agent.running).toBe(false);
      return;
    }
    const result = await agent.start();
    expect(result.agentInfo?.title).toBe('Fake Agent');
    expect(agent.running).toBe(true);
    const sent = procs[0].received[0];
    expect(sent.method).toBe('initialize');
    expect(sent.params.protocolVersion).toBe(1);
    expect(sent.params.clientCapabilities).toEqual({ fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  });

  it('starts one process for concurrent callers', async () => {
    const { agent, procs } = agentWith({ initialize: INIT_OK() });
    await Promise.all([agent.start(), agent.start(), agent.start()]);
    expect(procs).toHaveLength(1);
  });

  it('names a missing executable', async () => {
    const agent = new AcpAgent(['no-such-agent'], listener(), 'test', () => undefined, () => {
      // A process that never started answers nothing; it only errors.
      const p = new FakeAgentProcess({});
      p.stdin.removeAllListeners('data');
      setImmediate(() => p.emit('error', Object.assign(new Error('spawn no-such-agent ENOENT'), { code: 'ENOENT' })));
      return p.asChild();
    });
    await expect(agent.start()).rejects.toThrow('Could not start "no-such-agent": not found on PATH');
  });
});

describe('AcpAgent sessions', () => {
  it('creates a session that accepts prompts', async () => {
    const { agent, procs } = agentWith({
      initialize: INIT_OK(),
      'session/new': () => ({ sessionId: 's1' }),
      'session/prompt': () => ({ stopReason: 'end_turn' }),
    });
    const id = await agent.newSession('/work');
    expect(id).toBe('s1');
    expect(agent.isLive('s1')).toBe(true);
    await expect(agent.prompt('s1', [{ type: 'text', text: 'hi' }])).resolves.toEqual({ stopReason: 'end_turn' });
    expect(procs[0].received.find((m) => m.method === 'session/new').params).toEqual({ cwd: '/work', mcpServers: [] });
  });

  it('refuses a prompt for a session the process does not hold', async () => {
    const { agent } = agentWith({ initialize: INIT_OK() });
    await agent.start();
    await expect(agent.prompt('elsewhere', [])).rejects.toThrow('not open');
  });

  const openCases: Array<{ name: string; caps: object; replay: boolean; method?: string; error?: RegExp }> = [
    { name: 'loads when a replay is wanted', caps: { loadSession: true, sessionCapabilities: { resume: {} } }, replay: true, method: 'session/load' },
    { name: 'resumes when no replay is wanted', caps: { loadSession: true, sessionCapabilities: { resume: {} } }, replay: false, method: 'session/resume' },
    { name: 'loads when it cannot resume', caps: { loadSession: true }, replay: false, method: 'session/load' },
    { name: 'resumes when it cannot load', caps: { sessionCapabilities: { resume: {} } }, replay: true, method: 'session/resume' },
    { name: 'says so when it can do neither', caps: {}, replay: false, error: /can't reopen a session/ },
  ];
  it.each(openCases)('open $name', async ({ caps, replay, method, error }) => {
    const { agent, procs } = agentWith({
      initialize: INIT_OK(caps),
      'session/load': () => null,
      'session/resume': () => ({}),
    });
    const opening = agent.open('old', '/work', replay ? () => undefined : undefined);
    if (error) {
      await expect(opening).rejects.toThrow(error);
      expect(agent.isLive('old')).toBe(false);
      return;
    }
    await opening;
    expect(procs[0].sentMethods()).toContain(method);
    expect(agent.isLive('old')).toBe(true);
  });

  it('routes a load replay to its collector, not the listener', async () => {
    let fake!: FakeAgentProcess;
    const l = listener();
    const { agent, procs } = agentWith({
      initialize: INIT_OK({ loadSession: true }),
      'session/load': async (params) => {
        fake.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old prompt' } } });
        await flush();
        return null;
      },
    }, l);
    await agent.start();
    fake = procs[0];
    const replayed: any[] = [];
    await agent.open('old', '/work', (u) => replayed.push(u));
    fake.notify('session/update', { sessionId: 'old', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'live' } } });
    await flush();
    expect(replayed.map((u) => u.content.text)).toEqual(['old prompt']);
    expect(l.updates.map((u) => u.update.content.text)).toEqual(['live']);
  });

  it('shares one open between concurrent callers', async () => {
    const { agent, procs } = agentWith({ initialize: INIT_OK({ sessionCapabilities: { resume: {} } }), 'session/resume': async () => { await flush(); return {}; } });
    await Promise.all([agent.open('s', '/w'), agent.open('s', '/w')]);
    expect(procs[0].sentMethods().filter((m) => m === 'session/resume')).toHaveLength(1);
  });

  it('lists unfiltered and per folder, merged, following cursors', async () => {
    const pages: Record<string, any> = {
      '': { sessions: [{ sessionId: 'a', cwd: '/x' }], nextCursor: 'c2' },
      ':c2': { sessions: [{ sessionId: 'b', cwd: '/x' }] },
      '/p': { sessions: [{ sessionId: 'a', cwd: '/x', title: 'dup' }, { sessionId: 'c', cwd: '/p' }] },
    };
    const { agent } = agentWith({
      initialize: INIT_OK({ sessionCapabilities: { list: {} } }),
      'session/list': (params) => pages[`${params.cwd ?? ''}${params.cursor ? `:${params.cursor}` : ''}`],
    });
    const sessions = await agent.listSessions(['/p', '/p']);
    expect(sessions.map((s) => s.sessionId)).toEqual(['a', 'b', 'c']);
    expect(sessions[0].title).toBeUndefined();
  });

  it('lists nothing from an agent without session/list', async () => {
    const { agent, procs } = agentWith({ initialize: INIT_OK() });
    await expect(agent.listSessions(['/p'])).resolves.toEqual([]);
    expect(procs[0].sentMethods()).not.toContain('session/list');
  });
});

describe('AcpAgent requests from the agent', () => {
  it('answers a permission request with id 0 through the listener', async () => {
    const { agent, procs } = agentWith({ initialize: INIT_OK() }, listener({
      permission: async (req, id) => {
        expect(id).toBe(0);
        expect(req.options[0].optionId).toBe('yes');
        return { outcome: 'selected', optionId: 'yes' };
      },
    }));
    await agent.start();
    const response = await procs[0].request('session/request_permission', {
      sessionId: 's', toolCall: { toolCallId: 't' }, options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
    });
    expect(response).toEqual({ jsonrpc: '2.0', id: 0, result: { outcome: { outcome: 'selected', optionId: 'yes' } } });
  });

  const unsupported = ['fs/read_text_file', 'terminal/create', 'craft/drainMidTurnQueue'];
  it.each(unsupported)('declines %s as method not found', async (method) => {
    const { agent, procs } = agentWith({ initialize: INIT_OK() });
    await agent.start();
    const response = await procs[0].request(method, {});
    expect(response.error.code).toBe(-32601);
  });

  it('passes a withdrawn request on', async () => {
    const { agent, procs, l } = agentWith({ initialize: INIT_OK() });
    await agent.start();
    procs[0].notify('$/cancel_request', { requestId: 0 });
    await flush();
    expect(l.withdrawn).toEqual([0]);
  });

  it('ignores lines that are not JSON', async () => {
    const { agent, procs, l } = agentWith({ initialize: INIT_OK() });
    await agent.start();
    procs[0].writeRaw('starting up...\n');
    procs[0].notify('session/update', { sessionId: 's', update: { sessionUpdate: 'plan', entries: [] } });
    await flush();
    expect(l.updates).toHaveLength(1);
  });
});

describe('AcpAgent exit', () => {
  it('reports the exit, forgets its sessions and fails what was pending', async () => {
    let fake!: FakeAgentProcess;
    const { agent, procs, l } = agentWith({
      initialize: INIT_OK(),
      'session/new': () => ({ sessionId: 's1' }),
      'session/prompt': () => new Promise(() => undefined),
    });
    await agent.newSession('/w');
    fake = procs[0];
    const prompt = agent.prompt('s1', []);
    fake.stderr.write('panic: out of tokens\n');
    await flush();
    fake.exit(1);
    await expect(prompt).rejects.toThrow(/fake-acp exited \(code 1\): panic: out of tokens/);
    expect(l.exits).toHaveLength(1);
    expect(agent.isLive('s1')).toBe(false);
    expect(agent.running).toBe(false);
  });

  it('survives repeated process errors', async () => {
    const { agent, procs } = agentWith({ initialize: INIT_OK() });
    await agent.start();
    expect(() => {
      procs[0].emit('error', new Error('kill EPERM'));
      procs[0].emit('error', new Error('kill EPERM again'));
    }).not.toThrow();
  });

  it('starts a fresh process on next use', async () => {
    const { agent, procs } = agentWith({ initialize: INIT_OK(), 'session/new': () => ({ sessionId: 'n' }) });
    await agent.start();
    procs[0].exit(0);
    await flush();
    await agent.newSession('/w');
    expect(procs).toHaveLength(2);
  });
});
