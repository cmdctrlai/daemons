/**
 * Two agents on one transcript fork the JSONL and silently orphan a turn, so a
 * session id must never end up with more than one. These tests pile messages
 * onto one session – including concurrently, before any agent exists – and
 * assert a single agent takes all of them, in order.
 *
 * The daemon's task_id is per-session (device:agent:sessionId), so every
 * message for one session arrives with the SAME task_id.
 */

jest.mock('@anthropic-ai/claude-agent-sdk', () => require('./__mocks__/fake-agent-sdk'));
// Keep the entrypoint rewrite out of the test – it would scan the real
// ~/.claude/projects on close.
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));
// These tests assert on the direct-resume path. Force the background-agent
// delivery check to report "not a bg session" so it stays hermetic.
jest.mock('./claude-daemon', () => ({
  deliverToBgSession: jest.fn().mockResolvedValue({ delivered: false, reason: 'not-bg' }),
}));

import { ClaudeAdapter } from './claude-cli';
import { fakeAgents, resetFakeAgents, flush } from './__mocks__/fake-agent-sdk';

const taskFor = (session: string) => `dev:claude_code:${session}`;

describe('ClaudeAdapter session ownership', () => {
  let adapter: ClaudeAdapter;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    resetFakeAgents();
    adapter = new ClaudeAdapter(() => {});
  });

  afterEach(async () => {
    await adapter.stopAll();
    jest.restoreAllMocks();
  });

  it('gives concurrent resumes of one session a single agent', async () => {
    const task = taskFor('sess-A');
    await Promise.all([
      adapter.resumeTask(task, 'sess-A', 'first'),
      adapter.resumeTask(task, 'sess-A', 'second'),
    ]);
    await flush();

    expect(fakeAgents).toHaveLength(1);
    expect(fakeAgents[0].sent).toEqual(['first', 'second']);
  });

  it('drains a backlog of same-session messages in order, dropping none', async () => {
    const task = taskFor('sess-A');
    await Promise.all([
      adapter.resumeTask(task, 'sess-A', '1'),
      adapter.resumeTask(task, 'sess-A', '2'),
      adapter.resumeTask(task, 'sess-A', '3'),
    ]);
    await flush();

    expect(fakeAgents).toHaveLength(1);
    expect(fakeAgents[0].sent).toEqual(['1', '2', '3']);
  });

  it('sends a later message into the agent already holding the session', async () => {
    const task = taskFor('sess-A');
    await adapter.resumeTask(task, 'sess-A', 'first');
    await flush();
    expect(fakeAgents).toHaveLength(1);

    await adapter.resumeTask(task, 'sess-A', 'mid-turn');
    await flush();

    expect(fakeAgents).toHaveLength(1);
    expect(fakeAgents[0].sent).toEqual(['first', 'mid-turn']);
  });

  it('gives distinct sessions their own agents', async () => {
    await Promise.all([
      adapter.resumeTask(taskFor('sess-A'), 'sess-A', 'a'),
      adapter.resumeTask(taskFor('sess-B'), 'sess-B', 'b'),
    ]);
    await flush();

    expect(fakeAgents).toHaveLength(2);
    expect(fakeAgents.map((a) => a.sent)).toEqual([['a'], ['b']]);
  });

  it('starts a fresh agent after the previous one ends', async () => {
    const task = taskFor('sess-A');
    await adapter.resumeTask(task, 'sess-A', 'first');
    await flush();

    fakeAgents[0].end();
    await flush();

    await adapter.resumeTask(task, 'sess-A', 'after');
    await flush();

    expect(fakeAgents).toHaveLength(2);
    expect(fakeAgents[1].sent).toEqual(['after']);
  });

  it('cancels a session that has not reported its id yet', async () => {
    await adapter.startTask('task-new', 'hello', undefined);
    await flush();

    await adapter.cancelTask('task-new');
    expect(fakeAgents[0].interruptCalls).toBe(1);
    expect(adapter.getRunningTasks()).toEqual([]);
  });

  it('interrupts the running agent on cancel', async () => {
    const task = taskFor('sess-A');
    await adapter.resumeTask(task, 'sess-A', 'first');
    await flush();

    await adapter.cancelTask(task);
    expect(fakeAgents[0].interruptCalls).toBe(1);
    expect(adapter.getRunningTasks()).toEqual([]);
  });
});
