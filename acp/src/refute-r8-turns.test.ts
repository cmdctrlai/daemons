import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionUpdate, StopReason } from './acp/types';
import { flush } from './testing/fake-agent';
import { TranscriptStore, type Entry } from './transcript';
import { TurnManager, type TurnAgent, type TurnHandle } from './turns';

class ReplayingAgent implements TurnAgent {
  name = 'fake';
  canReplay = true;
  acceptsImages = false;
  live = new Set<string>(['s1']);
  history: SessionUpdate[] = [];
  prompts: Array<{ end: (reason: StopReason) => void }> = [];
  isLive(sessionId: string): boolean { return this.live.has(sessionId); }
  async open(sessionId: string, _cwd: string, onReplay?: (u: SessionUpdate) => void): Promise<void> {
    for (const update of this.history) onReplay?.(update);
    this.live.add(sessionId);
  }
  prompt(): Promise<{ stopReason: StopReason }> {
    return new Promise((resolve) => { this.prompts.push({ end: (stopReason) => resolve({ stopReason }) }); });
  }
  cancel(): void { /* the test ends prompts itself */ }
}

const handle = (): TurnHandle => ({
  taskId: 'dev:acp:s1',
  progress: () => undefined,
  complete: () => undefined,
  waitForUser: () => undefined,
  error: () => undefined,
});

const user = (text: string): SessionUpdate => ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } } as SessionUpdate);
const agentSays = (text: string): SessionUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } as SessionUpdate);

const NOTICE = 'IMPORTANT: This conversation approached the input token limit for stub-model. A compressed context will be sent for future messages (compressed from: 190000 to ~1010 tokens).';

describe('refute r8', () => {
  // Live (Qwen Code 0.26.5, local stub reporting 190000 prompt tokens): Qwen auto-compresses and
  // streams its notice as an agent_message_chunk, then the reply, with no message id or tool call
  // between. The app showed one message "...~1010 tokens).STUB REPLY: repro seven nine" (uuid
  // 00b69c61-...). Qwen saves only the reply, so the idle read-back gave the reply a new id
  // (21246e4603c1b58d3e1ab279925230e1) and the web's incremental reload appended it: the reply
  // shows twice in the pane while Qwen's session file holds it once.
  it('keeps a reply the app already shows under the id it was shown with after Qwen compresses', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r8-'));
    const agent = new ReplayingAgent();
    const shown: Entry[] = [];
    const sink = { agentText: (_s: string, entry: Entry) => shown.push(entry), tool: () => undefined, finished: () => undefined };
    const transcript = new TranscriptStore(dir);
    const turns = new TurnManager(agent, transcript, sink, () => undefined);

    void turns.send('s1', '/w', handle(), 'repro seven nine');
    await flush();
    turns.handleUpdate({ sessionId: 's1', update: agentSays(NOTICE) });
    turns.handleUpdate({ sessionId: 's1', update: agentSays('STUB REPLY:') });
    turns.handleUpdate({ sessionId: 's1', update: agentSays(' repro seven nine') });
    agent.prompts[0].end('end_turn');
    await flush();

    // Qwen's own replay of that turn (trace from the live run): the notice is not in it.
    agent.history = [user('repro seven nine'), agentSays('STUB REPLY: repro seven nine')];
    await turns.refresh('s1', '/w');

    const shownIds = new Set(shown.map((m) => m.uuid));
    const reply = transcript.page('s1', 50).messages.filter((m) => m.role === 'AGENT' && m.content.includes('STUB REPLY: repro seven nine'));
    expect(reply).toHaveLength(1);
    expect(shownIds.has(reply[0].uuid)).toBe(true);
  });
});
