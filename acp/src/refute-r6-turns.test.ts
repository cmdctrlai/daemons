import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionUpdate, StopReason } from './acp/types';
import { RpcRequestError } from './acp/connection';
import { flush } from './testing/fake-agent';
import { TranscriptStore } from './transcript';
import { TurnManager, type TurnAgent, type TurnHandle } from './turns';

/** An agent that replays a session's history on load, as Qwen Code does. */
class ReplayingAgent implements TurnAgent {
  name = 'fake';
  canReplay = true;
  acceptsImages = false;
  live = new Set<string>(['s1']);
  history: SessionUpdate[] = [];
  prompts: Array<{ sessionId: string; prompt: any[]; end: (reason: StopReason) => void; reject: (err: Error) => void }> = [];
  isLive(sessionId: string): boolean { return this.live.has(sessionId); }
  async open(sessionId: string, _cwd: string, onReplay?: (u: SessionUpdate) => void): Promise<void> {
    for (const update of this.history) onReplay?.(update);
    this.live.add(sessionId);
  }
  prompt(sessionId: string, prompt: any[]): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve, reject) => { this.prompts.push({ sessionId, prompt, end: (stopReason) => resolve({ stopReason }), reject }); });
  }
  cancel(): void { /* the test ends prompts itself */ }
}

function handle(taskId = 'dev:acp:s1') {
  const calls: Array<[string, ...unknown[]]> = [];
  const h: TurnHandle & { calls: typeof calls } = {
    taskId,
    calls,
    progress: (a, t) => calls.push(['progress', a, t]),
    complete: (r) => calls.push(['complete', r]),
    waitForUser: (p, _r, o) => calls.push(['waitForUser', p, o]),
    error: (m) => calls.push(['error', m]),
  };
  return h;
}

const sink = { agentText: () => undefined, tool: () => undefined, finished: () => undefined };
const user = (text: string): SessionUpdate => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } as SessionUpdate);
const agentSays = (text: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as SessionUpdate);

/** The daemon restarts: a new TurnManager over the same transcripts, the agent holding nothing open. */
function restart(dir: string, agent: ReplayingAgent) {
  agent.live.clear();
  const transcript = new TranscriptStore(dir);
  return { transcript, turns: new TurnManager(agent, transcript, sink, () => undefined) };
}

describe('refute r6', () => {
  // Live (Qwen Code 0.26.5, local stub): "fresh start" -> reply; "this will #fail" -> the model
  // call fails (agent_error); "after the failure" -> reply. Daemon restart, then get_messages.
  // Qwen replays the failed prompt and the next one as two back-to-back user_message_chunks
  // with no messageId. History afterwards held a third USER row "this will #failafter the failure",
  // timestamped now, placed before the earlier AGENT reply.
  it('does not double and glue user messages when a failed prompt is followed by another', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r6-'));
    const agent = new ReplayingAgent();
    let { transcript, turns } = restart(dir, agent);
    agent.live.add('s1');

    void turns.send('s1', '/w', handle(), 'fresh start');
    await flush();
    turns.handleUpdate({ sessionId: 's1', update: agentSays('STUB REPLY: fresh start') });
    agent.prompts[0].end('end_turn');
    await flush();

    void turns.send('s1', '/w', handle(), 'this will #fail');
    await flush();
    agent.prompts[1].reject(new Error('Internal error'));
    await flush();

    void turns.send('s1', '/w', handle(), 'after the failure');
    await flush();
    turns.handleUpdate({ sessionId: 's1', update: agentSays('STUB REPLY: after the failure') });
    agent.prompts[2].end('end_turn');
    await flush();

    const before = transcript.page('s1', 50).messages.map((m) => `${m.role}:${m.content}`);
    expect(before.filter((m) => m.startsWith('USER:'))).toEqual(['USER:fresh start', 'USER:this will #fail', 'USER:after the failure']);

    // Qwen's own replay of that session (trace from the live run).
    agent.history = [
      user('fresh start'), agentSays('STUB REPLY: fresh start'),
      user('this will #fail'), user('after the failure'), agentSays('STUB REPLY: after the failure'),
    ];
    ({ transcript, turns } = restart(dir, agent));
    await turns.refresh('s1', '/w');

    const after = transcript.page('s1', 50).messages.map((m) => `${m.role}:${m.content}`);
    expect(after).toEqual(before);
  });

  // Live (Qwen Code 0.26.5): the model call fails with HTTP 400. Qwen answers session/prompt with
  // {"code":-32603,"message":"Internal error","data":{"details":"400 stub: bad request"}}.
  // The app shows only "Internal error" -- a bad key, a rate limit and an outage all read the same.
  it('tells the user why the agent failed when the agent says so', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r6-'));
    const agent = new ReplayingAgent();
    const { turns } = restart(dir, agent);
    agent.live.add('s1');
    const h = handle();
    void turns.send('s1', '/w', h, 'this will #fail');
    await flush();
    agent.prompts[0].reject(new RpcRequestError('session/prompt', { code: -32603, message: 'Internal error', data: { details: '400 stub: bad request' } } as any));
    await flush();
    const shown = h.calls.filter((c) => c[0] === 'error').map((c) => c[1]);
    expect(shown.join(' ')).toContain('400 stub: bad request');
  });
});
