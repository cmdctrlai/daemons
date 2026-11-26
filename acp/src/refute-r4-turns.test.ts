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
  live = new Set<string>(['s1']);
  prompts: Array<{ sessionId: string; prompt: any[]; end: (reason: StopReason) => void }> = [];
  isLive(sessionId: string): boolean { return this.live.has(sessionId); }
  async open(sessionId: string, _cwd: string, _onReplay?: (u: SessionUpdate) => void): Promise<void> { this.live.add(sessionId); }
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

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r4-'));
  const agent = new ScriptedAgent();
  const transcript = new TranscriptStore(dir);
  const turns = new TurnManager(agent, transcript, {
    agentText: () => undefined,
    tool: () => undefined,
    finished: () => undefined,
  }, () => undefined);
  return { agent, transcript, turns };
}

describe('refute r4', () => {
  // Live: web shows "QUEUED: please also list the files" until reload, then it is gone;
  // the agent never saw it and nothing said it was dropped.
  it('keeps a message that Stop dropped from the queue in the history', async () => {
    const { agent, transcript, turns } = setup();
    const first = handle();
    void turns.send('s1', '/w', first, 'refactor the parser');
    await flush();
    void turns.send('s1', '/w', handle(), 'QUEUED: please also list the files');
    await flush();
    const stopping = turns.stop('s1', first.taskId);
    agent.prompts[0].end('cancelled');
    await stopping;
    await flush();

    const history = transcript.page('s1', 50).messages.map((m) => `${m.role}:${m.content}`);
    expect(history).toContain('USER:QUEUED: please also list the files');
  });

  // Live: Stop on a session still under its PENDING id, sent while the daemon awaits
  // session/new (start.ts:111), finds no turn; the task completes, then the prompt runs
  // to the end anyway (dsh 60-word reply 30s after Stop; Qwen the same with a 0.8s window
  // while the agent respawned).
  it('does not run a prompt whose task was stopped before its turn started', async () => {
    const { agent, turns } = setup();
    agent.live.add('s2');
    const pending = handle('dev:acp:PENDING-1');
    await turns.stop('', pending.taskId);
    void turns.send('s2', '/w', pending, '#slow gamma');
    await flush();

    expect(agent.prompts.map((p) => p.prompt[0].text)).toEqual([]);
  });
});
