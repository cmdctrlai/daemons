import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionUpdate, StopReason } from './acp/types';
import { flush } from './testing/fake-agent';
import { TranscriptStore, type Entry } from './transcript';
import { TurnManager, type TurnAgent, type TurnHandle } from './turns';

class ScriptedAgent implements TurnAgent {
  name = 'fake';
  canReplay = false;
  acceptsImages = false;
  live = new Set<string>(['s1']);
  prompts: Array<{ sessionId: string; prompt: any[]; end: (reason: StopReason) => void }> = [];
  cancels: string[] = [];
  isLive(sessionId: string): boolean { return this.live.has(sessionId); }
  async open(sessionId: string, _cwd: string, _onReplay?: (u: SessionUpdate) => void): Promise<void> { this.live.add(sessionId); }
  prompt(sessionId: string, prompt: any[]): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve) => { this.prompts.push({ sessionId, prompt, end: (stopReason) => resolve({ stopReason }) }); });
  }
  cancel(sessionId: string): void { this.cancels.push(sessionId); }
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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-'));
  const transcript = new TranscriptStore(dir);
  const agent = new ScriptedAgent();
  const sent: Entry[] = [];
  const turns = new TurnManager(agent, transcript, {
    agentText: (_s, e) => sent.push(e),
    tool: () => undefined,
    finished: () => undefined,
  }, () => undefined);
  const text = (t: string) => turns.handleUpdate({ sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } as SessionUpdate });
  const entries = () => transcript.get('s1')?.entries.map((e) => `${e.role}:${e.content}`) ?? [];
  return { transcript, agent, turns, sent, text, entries };
}

const OPTIONS = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' as const },
  { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
];
const REQUEST = {
  sessionId: 's1',
  toolCall: { toolCallId: 't1', title: 'bash', kind: 'execute' as const, rawInput: { command: 'rm -rf build' } },
  options: OPTIONS,
};

describe('refute r1: permission replies', () => {
  it('records a reply that turned down a permission once, not twice', async () => {
    const s = setup();
    const sending = s.turns.send('s1', '/w', handle(), 'clean up');
    await flush();
    void s.turns.permission(REQUEST, 0);
    await s.turns.send('s1', '/w', handle(), 'use the clean script instead');
    s.agent.prompts[0].end('end_turn');
    await sending;
    await flush();
    // The follow-up prompt is now running; the user typed their words once.
    const userLines = s.entries().filter((e) => e === 'USER:use the clean script instead');
    expect(userLines).toHaveLength(1);
  });

  it('does not lose the words when the agent ends a declined turn as cancelled', async () => {
    const s = setup();
    const sending = s.turns.send('s1', '/w', handle(), 'clean up');
    await flush();
    // An agent offering no reject option gets the outcome "cancelled", per the code.
    const outcome = s.turns.permission({ ...REQUEST, options: [OPTIONS[0]] }, 0);
    await s.turns.send('s1', '/w', handle(), 'use the clean script instead');
    await expect(outcome).resolves.toEqual({ outcome: 'cancelled' });
    // ACP: a permission answered "cancelled" means the turn was cancelled; the agent ends it so.
    s.agent.prompts[0].end('cancelled');
    await sending;
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['clean up', 'use the clean script instead']);
  });

  it('does not send the answer to a withdrawn card to the agent as a prompt', async () => {
    const s = setup();
    const first = handle();
    const sending = s.turns.send('s1', '/w', first, 'clean up');
    await flush();
    void s.turns.permission(REQUEST, 0);
    // The card is on screen and the server holds the task as waiting for the user.
    expect(first.calls.map(([k]) => k)).toContain('waitForUser');
    s.turns.withdraw(0);
    // The user taps the card still on screen.
    void s.turns.send('s1', '/w', handle(), 'Allow once');
    s.agent.prompts[0].end('end_turn');
    await sending;
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['clean up']);
  });

  it('a second tap on the same card (another device) is not sent to the agent as a prompt', async () => {
    const s = setup();
    const sending = s.turns.send('s1', '/w', handle(), 'clean up');
    await flush();
    void s.turns.permission(REQUEST, 0);
    await s.turns.send('s1', '/w', handle(), 'Allow once');
    void s.turns.send('s1', '/w', handle(), 'Allow once');
    s.text('done');
    s.agent.prompts[0].end('end_turn');
    await sending;
    await flush();
    expect(s.agent.prompts.map((p) => p.prompt[0].text)).toEqual(['clean up']);
  });
});
