import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionUpdate, StopReason } from './acp/types';
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
  prompts: Array<{ sessionId: string; prompt: any[]; end: (reason: StopReason) => void }> = [];
  isLive(sessionId: string): boolean { return this.live.has(sessionId); }
  async open(sessionId: string, _cwd: string, onReplay?: (u: SessionUpdate) => void): Promise<void> {
    for (const update of this.history) onReplay?.(update);
    this.live.add(sessionId);
  }
  prompt(sessionId: string, prompt: any[]): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve) => { this.prompts.push({ sessionId, prompt, end: (stopReason) => resolve({ stopReason }) }); });
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

describe('refute r5', () => {
  // Live (Qwen Code 0.26.5): "fourth #slow run", then "queued while running" while it
  // streams, then Stop. History shows the queued message (turn-5 fix). After a daemon
  // restart the next get_messages replays the session and the message is gone.
  // Changed for the user's rule – the agent is the system of record: once the session is
  // read back, its history is the agent's replay, which never held the queued message.
  it("after a restart reads the session back, its history is the agent's replay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r5-'));
    const agent = new ReplayingAgent();
    let { transcript, turns } = restart(dir, agent);
    agent.live.add('s1');
    const first = handle();
    void turns.send('s1', '/w', first, 'fourth #slow run');
    await flush();
    void turns.send('s1', '/w', handle(), 'queued while running');
    await flush();
    turns.handleUpdate({ sessionId: 's1', update: agentSays('word1 word2') });
    const stopping = turns.stop('s1', first.taskId);
    agent.prompts[0].end('cancelled');
    await stopping;
    await flush();
    expect(transcript.page('s1', 50).messages.map((m) => m.content)).toContain('queued while running');

    // The agent's own history: the prompt it ran and the partial reply. It never saw the queued one.
    agent.history = [user('fourth #slow run'), agentSays('word1 word2')];
    ({ transcript, turns } = restart(dir, agent));
    await turns.refresh('s1', '/w');

    expect(transcript.page('s1', 50).messages.map((m) => `${m.role}:${m.content}`))
      .toEqual(['USER:fourth #slow run', 'AGENT:word1 word2']);
  });

  // Live (Qwen Code 0.26.5): "again #write two" raises a card; the daemon restarts; the
  // app fetches the session (replay drops the card); the user taps Allow on the card
  // still on screen. "Allow" went to the agent as a new prompt ("STUB REPLY: Allow").
  it('does not send a tap on a card the restart closed as a prompt once the session is replayed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r5-'));
    const agent = new ReplayingAgent();
    let { transcript, turns } = restart(dir, agent);
    agent.live.add('s1');
    void turns.send('s1', '/w', handle(), 'again #write two');
    await flush();
    void turns.permission({
      sessionId: 's1',
      toolCall: { toolCallId: 't1', title: 'WriteFile', kind: 'edit' },
      options: [
        { optionId: 'always', name: 'Allow All Edits', kind: 'allow_always' },
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    } as any, 0);
    await flush();
    expect(transcript.page('s1', 50).messages.some((m) => m.question)).toBe(true);

    agent.history = [user('again #write two')];
    ({ transcript, turns } = restart(dir, agent));
    await turns.refresh('s1', '/w');
    void turns.send('s1', '/w', handle(), 'Allow');
    await flush();

    expect(agent.prompts.slice(1).map((p) => p.prompt[0].text)).toEqual([]);
  });

  // Live (Qwen Code 0.26.5, stub at 8ms/word): the daemon is stopped mid-reply. Shutdown
  // flushes ~400-500 words to the app as agent_message, then "The daemon is shutting down".
  // Qwen never saved the partial; after restart the first get_messages replays the session
  // and the reply the user saw is gone (3 of 3 trials).
  // Changed for the user's rule – the agent is the system of record: a reply the agent never
  // saved is gone once the session is read back (an accepted loss).
  it('after a restart reads the session back, a reply the agent never saved is gone', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r5-'));
    const agent = new ReplayingAgent();
    let { transcript, turns } = restart(dir, agent);
    agent.live.add('s1');
    void turns.send('s1', '/w', handle(), 'fast stream here #fast');
    await flush();
    turns.handleUpdate({ sessionId: 's1', update: agentSays('w1 w2 w3') });
    turns.agentExited(new Error('The daemon is shutting down'));
    await flush();
    expect(transcript.page('s1', 50).messages.map((m) => `${m.role}:${m.content}`)).toContain('AGENT:w1 w2 w3');

    agent.history = [user('fast stream here #fast')];
    ({ transcript, turns } = restart(dir, agent));
    await turns.refresh('s1', '/w');

    expect(transcript.page('s1', 50).messages.map((m) => `${m.role}:${m.content}`)).toEqual(['USER:fast stream here #fast']);
  });
});
