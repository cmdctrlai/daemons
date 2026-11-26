// Refuter round 1: each test fails against 52f267a2..fdce98a0 and names a defect.
import { ActivityReporter } from './activity';
import { OpenCodeAdapter } from './adapter/opencode';
import { turnState } from './adapter/transcript';
import { OpenCodeEvents } from './events';
import { FakeOpenCode, msg, waitFor } from './testing/fake-opencode';
import { TurnManager, type TurnHandle } from './turns';

const SID = 'ses_parent';
const CHILD = 'ses_child';
const DIR = '/work/alpha';

let fake: FakeOpenCode;
let adapter: OpenCodeAdapter;
let turns: TurnManager;
let events: OpenCodeEvents;

beforeEach(async () => {
  fake = new FakeOpenCode();
  const url = await fake.start();
  adapter = new OpenCodeAdapter(url);
  turns = new TurnManager(adapter, { tool: () => undefined, finished: () => undefined });
  adapter.busy = (directory) => turns.busyIn(directory);
  await new Promise<void>((resolve) => {
    events = new OpenCodeEvents(url, (e) => turns.handleEvent(e), () => { void turns.resync(); resolve(); });
    events.start();
  });
  await waitFor(() => fake.streamCount === 1, 'event stream');
  fake.transcripts.set(SID, [msg('m1', 'user', 'go')]);
  fake.sessionDirs.set(SID, DIR);
});

afterEach(async () => {
  events.stop();
  await fake.stop();
});

function recorder(): { calls: unknown[][]; handle: TurnHandle } {
  const calls: unknown[][] = [];
  return {
    calls,
    handle: {
      taskId: 'task',
      progress: () => undefined,
      complete: (result) => calls.push(['complete', result]),
      waitForUser: (prompt) => calls.push(['wait', prompt]),
      error: (message) => calls.push(['error', message]),
    },
  };
}

it('A: a permission a subagent raises (child session of the turn) reaches the user', async () => {
  const task = recorder();
  await turns.send(SID, task.handle, 'delegate the cleanup to a subagent');
  fake.emit('session.status', { sessionID: SID, status: { type: 'busy' } }, DIR);
  fake.emit('session.status', { sessionID: CHILD, status: { type: 'busy' } }, DIR);
  // Real opencode 1.18.25 raises the task tool's permission on the child session.
  fake.emit('permission.asked', {
    id: 'per_child', sessionID: CHILD, permission: 'bash', patterns: ['echo SUBAGENT_RAN'], metadata: {}, always: [],
  }, DIR);
  await new Promise((r) => setTimeout(r, 500));
  expect(task.calls).toEqual([['wait', 'Allow bash: echo SUBAGENT_RAN?']]);
});

describe('B/C: transcript tails a normal user produces', () => {
  const now = 1_700_000_100_000;
  const prompt = msg('u1', 'user', 'please refactor the parser', { time: { created: now - 5000 } });

  it('B: the completion for a turn that ended on a provider error does not carry the user\'s own prompt', async () => {
    const reporter = new ActivityReporter(adapter, {
      sendSessionActivity: (_id, _path, last, _count, completion) => sent.push({ last, completion }),
    });
    const sent: Array<{ last: string; completion: boolean }> = [];
    fake.transcripts.set(SID, [prompt]);
    await reporter.watch(SID);
    // Shape opencode stores for a 400 from the provider: no text, error set, completed.
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', {
      finish: undefined, error: { name: 'APIError', data: { message: 'quota exhausted' } }, time: { created: now - 4000, completed: now - 3900 },
    })]);
    await reporter.poll(SID);
    expect(sent).toHaveLength(1);
    expect(sent[0].completion).toBe(true);
    expect(sent[0].last).not.toBe('please refactor the parser');
  });

  it('C: a turn the user ended with Deny is not running (session row must not show busy)', () => {
    // Shape opencode stores after `reply: reject` with no message: the step ends on
    // finish=tool-calls, completed, the tool part errored, and the session is idle.
    const denied = msg('a1', 'assistant', '', { finish: 'tool-calls', time: { created: now - 4000, completed: now - 3000 } }, [{
      type: 'tool', tool: 'bash', callID: 'c1',
      state: { status: 'error', input: { command: 'rm -rf build' } },
    }]);
    const state = turnState([prompt, denied], now - 3000, now);
    expect(state.running).toBe(false);
  });
});
