import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionUpdate, StopReason } from './acp/types';
import { flush } from './testing/fake-agent';
import { TranscriptStore } from './transcript';
import { TurnManager, type TurnAgent, type TurnHandle } from './turns';

class ScriptedAgent implements TurnAgent {
  name = 'fake';
  canReplay = false;
  acceptsImages = false;
  constructor(public live = new Set<string>(['s1'])) {}
  prompts: Array<{ sessionId: string; prompt: any[]; end: (reason: StopReason) => void }> = [];
  isLive(sessionId: string): boolean { return this.live.has(sessionId); }
  async open(sessionId: string, _cwd: string, _onReplay?: (u: SessionUpdate) => void): Promise<void> { this.live.add(sessionId); }
  prompt(sessionId: string, prompt: any[]): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve) => { this.prompts.push({ sessionId, prompt, end: (stopReason) => resolve({ stopReason }) }); });
  }
  cancel(): void { /* not needed */ }
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

const REQUEST = {
  sessionId: 's1',
  toolCall: { toolCallId: 't1', title: 'write', kind: 'edit' as const, rawInput: { path: 'notes.txt' } },
  options: [
    { optionId: 'once', name: 'Allow once', kind: 'allow_once' as const },
    { optionId: 'no', name: 'Reject', kind: 'reject_once' as const },
  ],
};

/** A card on screen when the agent process goes away – a crash, or the daemon stopping. */
async function cardThenExit(reason: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r2-'));
  const transcript = new TranscriptStore(dir);
  const agent = new ScriptedAgent();
  const turns = new TurnManager(agent, transcript, sink, () => undefined);
  const first = handle();
  const sending = turns.send('s1', '/w', first, 'write the notes');
  await flush();
  void turns.permission(REQUEST, 0);
  expect(first.calls.map(([k]) => k)).toContain('waitForUser');
  agent.live.delete('s1');
  turns.agentExited(new Error(reason));
  await sending;
  return { dir, transcript, agent, turns };
}

const newestIsOpenCard = (t: TranscriptStore) => !!t.page('s1', 50).messages.at(-1)?.question;
const sentAsPrompt = (a: ScriptedAgent, text: string) => a.prompts.some((p) => p.prompt[0].text === text);

describe('refute r2: a card whose agent went away', () => {
  it('agent crash: the card is not left answerable with the tap sent to the agent as a prompt', async () => {
    const s = await cardThenExit('fake exited (signal SIGKILL)');
    const cardStillOffered = newestIsOpenCard(s.transcript);
    // The user taps the card the app still shows as answerable.
    void s.turns.send('s1', '/w', handle(), 'Allow once');
    await flush();
    const tapSentAsPrompt = sentAsPrompt(s.agent, 'Allow once');
    expect({ cardStillOffered, tapSentAsPrompt }).not.toEqual({ cardStillOffered: true, tapSentAsPrompt: true });
  });

  it('daemon restart: the card is not left answerable with the tap sent to the agent as a prompt', async () => {
    const s = await cardThenExit('The daemon is shutting down');
    // A fresh daemon process over the same transcript directory, with a fresh agent.
    const transcript = new TranscriptStore(s.dir);
    const agent = new ScriptedAgent(new Set());
    const turns = new TurnManager(agent, transcript, sink, () => undefined);
    const cardStillOffered = newestIsOpenCard(transcript);
    void turns.send('s1', '/w', handle(), 'Allow once');
    await flush();
    const tapSentAsPrompt = sentAsPrompt(agent, 'Allow once');
    expect({ cardStillOffered, tapSentAsPrompt }).not.toEqual({ cardStillOffered: true, tapSentAsPrompt: true });
  });
});
