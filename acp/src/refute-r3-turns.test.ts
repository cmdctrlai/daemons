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

describe('refute r3: a message sent while the agent works', () => {
  // The server keys "running" by session: any TASK_COMPLETE (handle.complete) clears it,
  // and finished() is the completion push. Both fire while the queued message still runs.
  it('does not report the session finished while the queued message is still running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r3-'));
    const agent = new ScriptedAgent();
    let finished = 0;
    const turns = new TurnManager(agent, new TranscriptStore(dir), {
      agentText: () => undefined,
      tool: () => undefined,
      finished: () => { finished++; },
    }, () => undefined);

    const first = handle();
    const second = handle();
    void turns.send('s1', '/w', first, 'refactor the parser');
    await flush();
    void turns.send('s1', '/w', second, 'and add tests for it');
    await flush();
    agent.prompts[0].end('end_turn');
    await flush();

    // The second prompt is now with the agent and has not ended.
    expect(agent.prompts.map((p) => p.prompt[0].text)).toEqual(['refactor the parser', 'and add tests for it']);
    const completed = [...first.calls, ...second.calls].filter((c) => c[0] === 'complete');
    expect({ completed: completed.length, finished }).toEqual({ completed: 0, finished: 0 });
  });
});
