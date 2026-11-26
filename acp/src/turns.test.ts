import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { RequestPermissionOutcome, SessionUpdate, StopReason } from './acp/types';
import { flush } from './testing/fake-agent';
import { CLOSED_NOTE, TranscriptStore, type Entry } from './transcript';
import { Replay, STOP_GRACE_MS, TurnManager, type TurnAgent, type TurnHandle } from './turns';

/** An agent whose prompts end when the test says so. */
class ScriptedAgent implements TurnAgent {
  name = 'fake';
  canReplay = false;
  acceptsImages = false;
  live = new Set<string>(['s1']);
  prompts: Array<{ sessionId: string; prompt: any[]; end: (reason: StopReason) => void; fail: (err: Error) => void }> = [];
  cancels: string[] = [];
  opens: string[] = [];
  replay: SessionUpdate[] = [];

  isLive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }
  /** Held open until the test releases it, when set. */
  gate: Promise<void> | null = null;
  private opening = new Map<string, Promise<void>>();
  /** Like AcpAgent: callers opening one session at once share it, and only the first gets the replay. */
  open(sessionId: string, _cwd: string, onReplay?: (u: SessionUpdate) => void): Promise<void> {
    const inFlight = this.opening.get(sessionId);
    if (inFlight) return inFlight;
    const opening = (async () => {
      this.opens.push(sessionId);
      await this.gate;
      for (const u of this.replay) onReplay?.(u);
      this.live.add(sessionId);
    })().finally(() => this.opening.delete(sessionId));
    this.opening.set(sessionId, opening);
    return opening;
  }
  prompt(sessionId: string, prompt: any[]): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve, reject) => {
      this.prompts.push({ sessionId, prompt, end: (stopReason) => resolve({ stopReason }), fail: reject });
    });
  }
  cancel(sessionId: string): void {
    this.cancels.push(sessionId);
  }
  last() {
    return this.prompts[this.prompts.length - 1];
  }
}

function handle(taskId = 'dev:acp:s1') {
  const calls: Array<[string, ...unknown[]]> = [];
  const h: TurnHandle & { calls: typeof calls } = {
    taskId,
    calls,
    progress: (a, t) => calls.push(['progress', a, t]),
    complete: (r) => calls.push(['complete', r]),
    waitForUser: (p, r, o) => calls.push(['waitForUser', p, o]),
    error: (m) => calls.push(['error', m]),
  };
  return h;
}

const ended = (h: ReturnType<typeof handle>) => h.calls.filter(([k]) => k === 'complete' || k === 'error' || k === 'waitForUser');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-turns-'));
  const transcript = new TranscriptStore(dir);
  const agent = new ScriptedAgent();
  const sent: Entry[] = [];
  const tools: string[] = [];
  const finished: string[] = [];
  const working: string[] = [];
  const turns = new TurnManager(agent, transcript, {
    agentText: (_s, e) => sent.push(e),
    tool: (_t, _c, line) => tools.push(line),
    finished: (_s, last) => finished.push(last),
    working: (taskId) => working.push(taskId),
  }, () => undefined);
  const update = (u: object, sessionId = 's1') => turns.handleUpdate({ sessionId, update: u as SessionUpdate });
  const text = (t: string, messageId?: string) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t }, messageId });
  const entries = (sessionId = 's1') => transcript.get(sessionId)?.entries.map((e) => `${e.role}:${e.content}`) ?? [];
  return { dir, transcript, agent, turns, sent, tools, finished, working, update, text, entries };
}

const PERMISSION = {
  sessionId: 's1',
  toolCall: { toolCallId: 't1', title: 'bash', kind: 'execute' as const, rawInput: { command: 'rm -rf build' } },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' as const },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
  ],
};

describe('TurnManager streaming', () => {
  it('reports each finished piece of text as it completes, and the turn on completion', async () => {
    const s = setup();
    const h = handle();
    const sending = s.turns.send('s1', '/w', h, 'build it');
    await flush();
    s.text('Looking', 'm1');
    s.text(' around.', 'm1');
    expect(s.sent).toHaveLength(0);
    s.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
    expect(s.sent.map((e) => e.content)).toEqual(['Looking around.']);
    s.update({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' });
    s.text('All green.', 'm2');
    s.agent.last().end('end_turn');
    await sending;
    expect(s.sent.map((e) => e.content)).toEqual(['Looking around.', 'All green.']);
    expect(s.tools).toEqual(['Running npm test']);
    expect(h.calls).toContainEqual(['progress', 'Running', 'npm test']);
    expect(ended(h)).toEqual([['complete', 'All green.']]);
    expect(s.finished).toEqual(['All green.']);
    expect(s.working).toEqual([]);
    expect(s.entries()).toEqual(['USER:build it', 'AGENT:Looking around.', 'AGENT:All green.']);
  });

  const splits: Array<{ name: string; chunks: Array<[string, string?]>; sent: string[] }> = [
    { name: 'splits text when the message id changes', chunks: [['one', 'a'], ['two', 'b']], sent: ['one', 'two'] },
    { name: 'runs on chunks without ids', chunks: [['one'], [' two']], sent: ['one two'] },
    {
      name: 'splits text at an empty chunk, so a status line keeps out of the reply',
      chunks: [['Compressed.'], [''], [''], ['STUB REPLY:'], [' hi'], ['']],
      sent: ['Compressed.', 'STUB REPLY: hi'],
    },
    { name: 'sends nothing for empty chunks around a reply', chunks: [[''], ['reply'], ['']], sent: ['reply'] },
  ];
  it.each(splits)('$name', async ({ chunks, sent }) => {
    const s = setup();
    const sending = s.turns.send('s1', '/w', handle(), 'hi');
    await flush();
    for (const [t, id] of chunks) s.text(t, id);
    s.agent.last().end('end_turn');
    await sending;
    expect(s.sent.map((e) => e.content)).toEqual(sent);
    expect(new Set(s.sent.map((e) => e.uuid)).size).toBe(sent.length);
  });

  it('ignores empty chunks and non-text content', async () => {
    const s = setup();
    const sending = s.turns.send('s1', '/w', handle(), 'hi');
    await flush();
    s.text('');
    s.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x', mimeType: 'image/png' } });
    s.agent.last().end('end_turn');
    await sending;
    expect(s.sent).toHaveLength(0);
  });

  const endings: Array<{ reason: StopReason; outcome: [string, string]; note?: RegExp }> = [
    { reason: 'end_turn', outcome: ['complete', 'done'] },
    { reason: 'max_tokens', outcome: ['complete', '_The agent stopped: it reached its output limit._'], note: /output limit/ },
    { reason: 'max_turn_requests', outcome: ['complete', '_The agent stopped: it reached its limit of steps for one turn._'], note: /limit of steps/ },
    { reason: 'refusal', outcome: ['error', 'fake declined to continue with this request.'] },
    { reason: 'cancelled', outcome: ['complete', ''] },
  ];
  it.each(endings)('ends a turn that stops with $reason', async ({ reason, outcome, note }) => {
    const s = setup();
    const h = handle();
    const sending = s.turns.send('s1', '/w', h, 'go');
    await flush();
    s.text('done');
    s.agent.last().end(reason);
    await sending;
    expect(ended(h)).toEqual([outcome]);
    if (note) expect(s.entries().pop()).toMatch(note);
  });

  it('runs one prompt at a time per session, in order', async () => {
    const s = setup();
    const first = s.turns.send('s1', '/w', handle(), 'first');
    const second = s.turns.send('s1', '/w', handle(), 'second');
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['first']);
    s.agent.last().end('end_turn');
    await first;
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['first', 'second']);
    s.agent.last().end('end_turn');
    await second;
  });

  it('fails the turn when the agent exits', async () => {
    const s = setup();
    const h = handle();
    const sending = s.turns.send('s1', '/w', h, 'go');
    await flush();
    s.text('half');
    s.turns.agentExited(new Error('fake exited (code 1)'));
    await sending;
    expect(ended(h)).toEqual([['error', 'fake exited (code 1)']]);
    expect(s.sent.map((e) => e.content)).toEqual(['half']);
    expect(s.turns.isBusy('s1')).toBe(false);
  });

  it('reopens a session the agent does not hold before prompting', async () => {
    const s = setup();
    const sending = s.turns.send('old', '/w', handle('dev:acp:old'), 'again');
    await flush();
    expect(s.agent.opens).toEqual(['old']);
    s.agent.last().end('end_turn');
    await sending;
  });

  it('sends images only to an agent that accepts them', async () => {
    const s = setup();
    const image = 'data:image/png;base64,AAAA';
    let sending = s.turns.send('s1', '/w', handle(), 'look', [image]);
    await flush();
    expect(s.agent.last().prompt).toEqual([{ type: 'text', text: 'look' }]);
    s.agent.last().end('end_turn');
    await sending;
    s.agent.acceptsImages = true;
    sending = s.turns.send('s1', '/w', handle(), 'look', [image]);
    await flush();
    expect(s.agent.last().prompt[1]).toEqual({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
    s.agent.last().end('end_turn');
    await sending;
  });
});

describe('TurnManager permission cards', () => {
  async function asking() {
    const s = setup();
    const first = handle();
    const sending = s.turns.send('s1', '/w', first, 'clean up');
    await flush();
    s.update({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'bash', kind: 'execute', status: 'pending', rawInput: { command: 'rm -rf build' } });
    const outcome = s.turns.permission(PERMISSION, 0);
    return { s, first, sending, outcome };
  }

  it('shows the request as a card and ends the task waiting for the user', async () => {
    const { s, first, outcome } = await asking();
    expect(ended(first)).toEqual([['waitForUser', 'Allow: Running rm -rf build?', [{ label: 'Allow once' }, { label: 'Always allow' }, { label: 'Reject' }]]]);
    const card = s.transcript.get('s1')!.entries.pop()!;
    expect(card.question).toEqual({ question: 'Allow: Running rm -rf build?', header: 'Permission', options: [{ label: 'Allow once' }, { label: 'Always allow' }, { label: 'Reject' }] });
    void outcome;
  });

  const answers: Array<{ reply: string; outcome: RequestPermissionOutcome; followUp?: string }> = [
    { reply: 'Allow once', outcome: { outcome: 'selected', optionId: 'once' } },
    { reply: 'always allow', outcome: { outcome: 'selected', optionId: 'always' } },
    { reply: 'Reject', outcome: { outcome: 'selected', optionId: 'no' } },
    { reply: 'yes', outcome: { outcome: 'selected', optionId: 'once' } },
    { reply: 'no.', outcome: { outcome: 'selected', optionId: 'no' } },
    { reply: 'use the clean script instead', outcome: { outcome: 'selected', optionId: 'no' }, followUp: 'use the clean script instead' },
  ];
  it.each(answers)('answers "$reply"', async ({ reply, outcome, followUp }) => {
    const { s, sending, outcome: pending } = await asking();
    const second = handle();
    await s.turns.send('s1', '/w', second, reply);
    await expect(pending).resolves.toEqual(outcome);
    expect(s.entries().slice(-1)).toEqual([`USER:${reply}`]);
    // The same prompt carries on, now reporting to the reply's task.
    s.text('carried on');
    s.agent.prompts[0].end('end_turn');
    await sending;
    if (!followUp) {
      expect(ended(second)).toEqual([['complete', 'carried on']]);
      expect(s.agent.prompts).toHaveLength(1);
      return;
    }
    // Words rather than a choice become the next prompt, on the same task.
    await flush();
    expect(s.agent.prompts).toHaveLength(2);
    expect(s.agent.last().prompt[0].text).toBe(followUp);
    expect(ended(second)).toEqual([]);
    s.text('used the clean script');
    s.agent.last().end('end_turn');
    await flush();
    expect(ended(second)).toEqual([['complete', 'used the clean script']]);
  });

  it('presents a second request once the first is answered', async () => {
    const { s, outcome } = await asking();
    const second = s.turns.permission({ ...PERMISSION, toolCall: { toolCallId: 't2', title: 'write', kind: 'edit', rawInput: { file_path: '/w/a.txt' } } }, 1);
    const reply = handle();
    await s.turns.send('s1', '/w', reply, 'Allow once');
    await expect(outcome).resolves.toEqual({ outcome: 'selected', optionId: 'once' });
    expect(ended(reply)).toEqual([['waitForUser', 'Allow: Editing /w/a.txt?', expect.any(Array)]]);
    await s.turns.send('s1', '/w', handle(), 'Reject');
    await expect(second).resolves.toEqual({ outcome: 'selected', optionId: 'no' });
  });

  it('cancels a request the agent raises for a session with no turn', async () => {
    const s = setup();
    await expect(s.turns.permission({ ...PERMISSION, sessionId: 'nobody' }, 3)).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('drops a request the agent withdraws, and the turn still ends on its task', async () => {
    const { s, first, sending, outcome } = await asking();
    s.turns.withdraw(0);
    await expect(outcome).resolves.toEqual({ outcome: 'cancelled' });
    s.agent.prompts[0].end('end_turn');
    await sending;
    expect(ended(first).map(([k]) => k)).toEqual(['waitForUser', 'complete']);
  });
});

describe('cards whose turn is gone', () => {
  async function cardShown(s: ReturnType<typeof setup>) {
    const first = handle();
    const sending = s.turns.send('s1', '/w', first, 'clean up');
    await flush();
    void s.turns.permission(PERMISSION, 0);
    return { first, sending };
  }
  const newest = (s: ReturnType<typeof setup>) => s.transcript.page('s1', 50).messages.at(-1)!;

  it('a daemon killed outright leaves no answerable card, and a late tap is not a prompt', async () => {
    const s = setup();
    await cardShown(s);
    // No exit event: the next daemon finds the card as the old one left it.
    const transcript = new TranscriptStore(s.dir);
    const agent = new ScriptedAgent();
    const turns = new TurnManager(agent, transcript, { agentText: () => undefined, tool: () => undefined, finished: () => undefined }, () => undefined);
    const card = transcript.page('s1', 50).messages.at(-1)!;
    expect(card.question).toBeUndefined();
    expect(card.content).toBe(`Allow: Running rm -rf build?\n\n${CLOSED_NOTE}`);
    expect('closed' in card).toBe(false);
    const late = handle();
    await turns.send('s1', '/w', late, 'Allow once');
    expect(agent.prompts).toHaveLength(0);
    expect(ended(late)).toEqual([['complete', '']]);
  });

  it('Stop closes the card it leaves behind', async () => {
    const s = setup();
    const { first } = await cardShown(s);
    const stopping = s.turns.stop('s1', first.taskId);
    s.agent.last().end('cancelled');
    await stopping;
    expect(newest(s).question).toBeUndefined();
    expect(newest(s).content).toContain(CLOSED_NOTE);
  });

  it('an answered card keeps its choices across a restart', async () => {
    const s = setup();
    const { sending } = await cardShown(s);
    await s.turns.send('s1', '/w', handle(), 'Allow once');
    s.agent.last().end('end_turn');
    await sending;
    new TurnManager(new ScriptedAgent(), new TranscriptStore(s.dir), { agentText: () => undefined, tool: () => undefined, finished: () => undefined }, () => undefined);
    const card = new TranscriptStore(s.dir).get('s1')!.entries.find((e) => e.content.startsWith('Allow:'))!;
    expect(card.question?.options.map((o) => o.label)).toEqual(['Allow once', 'Always allow', 'Reject']);
  });

  it('once the user has moved on, the same words are a prompt again', async () => {
    const s = setup();
    const { sending } = await cardShown(s);
    s.turns.agentExited(new Error('gone'));
    await sending;
    const next = s.turns.send('s1', '/w', handle(), 'something else');
    await flush();
    s.agent.last().end('end_turn');
    await next;
    const again = s.turns.send('s1', '/w', handle(), 'Allow once');
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['clean up', 'something else', 'Allow once']);
    s.agent.last().end('end_turn');
    await again;
  });
});

describe('a message sent while the agent works', () => {
  it('Stop stops the queued message too, and a message after Stop still runs', async () => {
    const s = setup();
    const first = handle();
    const queued = handle();
    void s.turns.send('s1', '/w', first, 'refactor the parser');
    await flush();
    void s.turns.send('s1', '/w', queued, 'and add tests for it');
    await flush();
    expect(s.turns.isBusy('s1')).toBe(true);
    const stopping = s.turns.stop('s1', first.taskId);
    s.agent.last().end('cancelled');
    await stopping;
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['refactor the parser']);
    expect(ended(first)).toEqual([['complete', '']]);
    expect(ended(queued)).toEqual([['complete', '']]);
    expect(s.finished).toEqual([]);
    expect(s.turns.isBusy('s1')).toBe(false);
    // The words the user sent stay in the history; only the agent never sees them.
    expect(s.entries()).toEqual(['USER:refactor the parser', 'USER:and add tests for it']);

    const after = handle();
    void s.turns.send('s1', '/w', after, 'try again');
    await flush();
    expect(s.agent.last().prompt[0].text).toBe('try again');
    s.text('done');
    s.agent.last().end('end_turn');
    await flush();
    expect(ended(after)).toEqual([['complete', 'done']]);
  });

  it('ends a first turn still under its PENDING id when the run ends, with one completion', async () => {
    const s = setup();
    const first = handle('dev:acp:PENDING-1');
    const second = handle('dev:acp:s1');
    void s.turns.send('s1', '/w', first, 'one');
    await flush();
    void s.turns.send('s1', '/w', second, 'two');
    await flush();
    s.text('first answer');
    s.agent.last().end('end_turn');
    await flush();
    expect(ended(first)).toEqual([]);
    // The first reply cleared the apps' working state; the second message's start restores it.
    expect(s.working).toEqual(['dev:acp:s1']);
    s.text('second answer');
    s.agent.last().end('end_turn');
    await flush();
    expect(ended(first)).toEqual([['complete', '']]);
    expect(ended(second)).toEqual([['complete', 'second answer']]);
    expect(s.finished).toEqual(['second answer']);
  });

  it('does not send queued messages after the turn fails', async () => {
    const s = setup();
    const first = handle();
    const queued = handle();
    void s.turns.send('s1', '/w', first, 'one');
    await flush();
    void s.turns.send('s1', '/w', queued, 'two');
    await flush();
    s.turns.agentExited(new Error('fake exited (code 1)'));
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['one']);
    expect(ended(first)).toEqual([['error', 'fake exited (code 1)']]);
    expect(ended(queued)).toEqual([['complete', '']]);
  });
});

describe('a stop that comes before the turn starts', () => {
  it('keeps the stopped first message in the history and runs the next one', async () => {
    const s = setup();
    const pending = handle('dev:acp:PENDING-7');
    await expect(s.turns.stop('', pending.taskId)).resolves.toBe(false);
    await s.turns.send('s1', '/w', pending, 'never runs');
    expect(s.agent.prompts).toEqual([]);
    expect(ended(pending)).toEqual([['complete', '']]);
    expect(s.entries()).toEqual(['USER:never runs']);
    // The stop is spent: the same task id is not stopped again.
    void s.turns.send('s1', '/w', handle('dev:acp:PENDING-7'), 'runs');
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['runs']);
  });

  it('a Stop on an idle session does not hold back its next message', async () => {
    const s = setup();
    await expect(s.turns.stop('s1', 'dev:acp:s1')).resolves.toBe(false);
    void s.turns.send('s1', '/w', handle('dev:acp:s1'), 'next');
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['next']);
  });
});

describe('when the daemon stops', () => {
  it('tells the app a waiting message was not sent, and keeps it out of the history', async () => {
    const s = setup();
    const first = handle();
    const waiting = handle();
    void s.turns.send('s1', '/w', first, 'working on it');
    await flush();
    void s.turns.send('s1', '/w', waiting, 'and then this');
    await flush();
    // What start.ts does on SIGTERM: shut the turns down, then stop the agent.
    s.turns.shutdown();
    s.turns.agentExited(new Error('The daemon is shutting down'));
    await flush();
    expect(ended(waiting)).toEqual([['error', 'Not sent: the daemon stopped']]);
    expect(ended(first)).toEqual([['error', 'The daemon is shutting down']]);
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['working on it']);
    expect(s.entries()).toEqual(['USER:working on it']);
  });
});

describe('TurnManager stop', () => {
  it('cancels the prompt, answers open requests as cancelled, and ends the task', async () => {
    const s = setup();
    const h = handle();
    const sending = s.turns.send('s1', '/w', h, 'go');
    await flush();
    const outcome = s.turns.permission(PERMISSION, 0);
    const stopping = s.turns.stop('s1', h.taskId);
    await expect(outcome).resolves.toEqual({ outcome: 'cancelled' });
    expect(s.agent.cancels).toEqual(['s1']);
    // The agent may flush text it had before answering; tool news is dropped.
    s.text('partial');
    s.update({ sessionUpdate: 'tool_call', toolCallId: 'x', title: 'bash', status: 'in_progress' });
    s.agent.last().end('cancelled');
    await expect(stopping).resolves.toBe(true);
    await sending;
    expect(ended(h)).toEqual([['waitForUser', expect.any(String), expect.any(Array)], ['complete', '']]);
    expect(s.sent.map((e) => e.content)).toEqual(['partial']);
    expect(s.tools).toEqual([]);
    expect(s.finished).toEqual([]);
  });

  it('finds a turn by the PENDING task id that started it', async () => {
    const s = setup();
    const h = handle('dev:acp:PENDING-1');
    void s.turns.send('s1', '/w', h, 'go');
    await flush();
    const stopping = s.turns.stop('', 'dev:acp:PENDING-1');
    s.agent.last().end('cancelled');
    await expect(stopping).resolves.toBe(true);
  });

  it('reports nothing running when there is no turn', async () => {
    const s = setup();
    await expect(s.turns.stop('s1', 'dev:acp:s1')).resolves.toBe(false);
  });

  it('ends the turn itself when the agent ignores the cancel, and the next message runs', async () => {
    jest.useFakeTimers();
    try {
      const s = setup();
      const h = handle();
      void s.turns.send('s1', '/w', h, 'stuck');
      await jest.advanceTimersByTimeAsync(5);
      const stopping = s.turns.stop('s1', h.taskId);
      await jest.advanceTimersByTimeAsync(STOP_GRACE_MS);
      await expect(stopping).resolves.toBe(true);
      expect(ended(h)).toEqual([['complete', '']]);
      const next = handle();
      void s.turns.send('s1', '/w', next, 'next');
      await jest.advanceTimersByTimeAsync(5);
      expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['stuck', 'next']);
      // The ignored prompt ending late changes nothing.
      s.agent.prompts[0].end('end_turn');
      await jest.advanceTimersByTimeAsync(5);
      expect(ended(h)).toEqual([['complete', '']]);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('Replay and refresh', () => {
  it('gathers replayed chunks into messages with stable ids, never gluing user messages', () => {
    const updates: SessionUpdate[] = [
      // Back-to-back prompts with no ids, as Qwen Code replays a failed one and the next.
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'this will #fail' } },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'after the failure' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Looking' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '.' } },
      { sessionUpdate: 'tool_call', toolCallId: 't', title: 'bash' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixed.' } },
      // One message in two chunks under one id stays one message.
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'part ' }, messageId: 'u2' },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'two' }, messageId: 'u2' },
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'three' }, messageId: 'u3' },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' ' }, messageId: 'a3' },
    ];
    const build = () => {
      const r = new Replay('sess');
      updates.forEach((u) => r.add(u));
      return r.entries();
    };
    const entries = build();
    expect(entries.map((e) => `${e.role}:${e.content}`)).toEqual([
      'USER:this will #fail', 'USER:after the failure', 'AGENT:Looking.', 'AGENT:Fixed.', 'USER:part two', 'USER:three',
    ]);
    expect(build().map((e) => e.uuid)).toEqual(entries.map((e) => e.uuid));
    expect([...entries].sort((a, b) => a.timestamp.localeCompare(b.timestamp))).toEqual(entries);
  });

  it("takes the agent's replay as the history, and reads it back again on the next refresh", async () => {
    const s = setup();
    const at = new Date().toISOString();
    s.transcript.append('old', '/w', { uuid: 'u', role: 'USER', content: 'asked here', timestamp: at });
    s.transcript.append('old', '/w', { uuid: 'cut', role: 'AGENT', content: 'a reply only the daemon saw', timestamp: at });
    s.agent.canReplay = true;
    s.agent.replay = [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'asked here' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'what the agent saved' } },
    ];
    await s.turns.refresh('old', '/w');
    expect(s.entries('old')).toEqual(['USER:asked here', 'AGENT:what the agent saved']);
    // A message the app already showed keeps its id; nothing else of the record survives.
    expect(s.transcript.get('old')!.entries.map((e) => e.uuid)[0]).toBe('u');

    // A turn taken in the agent's own terminal meanwhile shows on the next refresh.
    s.agent.replay.push(
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'typed in the terminal' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'terminal answer' } },
    );
    await s.turns.refresh('old', '/w');
    expect(s.entries('old')).toEqual(['USER:asked here', 'AGENT:what the agent saved', 'USER:typed in the terminal', 'AGENT:terminal answer']);
  });

  it('does not read back a session while a turn runs there', async () => {
    const s = setup();
    s.agent.canReplay = true;
    void s.turns.send('s1', '/w', handle(), 'working');
    await flush();
    await s.turns.refresh('s1', '/w');
    expect(s.agent.opens).toEqual([]);
    s.agent.last().end('end_turn');
  });

  it('keeps the replayed history when a message arrives while the replay is loading', async () => {
    const s = setup();
    s.agent.canReplay = true;
    s.agent.replay = [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'from the agent' } }];
    let release!: () => void;
    s.agent.gate = new Promise((r) => { release = r; });
    const refreshing = s.turns.refresh('old', '/w');
    const sending = s.turns.send('old', '/w', handle('dev:acp:old'), 'next prompt');
    release();
    await refreshing;
    await flush();
    s.agent.last().end('end_turn');
    await sending;
    expect(s.agent.opens).toEqual(['old']);
    expect(s.entries('old')).toEqual(['USER:from the agent', 'USER:next prompt']);
  });

  it('leaves the record alone when the agent cannot replay', async () => {
    const s = setup();
    s.transcript.append('old', '/w', { uuid: 'u', role: 'USER', content: 'kept', timestamp: new Date().toISOString() });
    await s.turns.refresh('old', '/w');
    expect(s.agent.opens).toEqual([]);
    expect(s.entries('old')).toEqual(['USER:kept']);
  });
});
