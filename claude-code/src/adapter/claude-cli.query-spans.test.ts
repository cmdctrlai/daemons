/**
 * The adapter records when it had a query alive on each session. The session watcher
 * asks about a prompt's timestamp to tell the adapter's turns, which the adapter's
 * `result` announces, from every other turn on the transcript.
 */

jest.mock('@anthropic-ai/claude-agent-sdk', () => require('./__mocks__/fake-agent-sdk'));
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));
jest.mock('./claude-daemon', () => ({
  deliverToBgSession: jest.fn(),
}));

import { ClaudeAdapter } from './claude-cli';
import { deliverToBgSession } from './claude-daemon';
import { fakeAgents, resetFakeAgents, flush } from './__mocks__/fake-agent-sdk';

const mockDeliver = deliverToBgSession as jest.Mock;

describe('ClaudeAdapter query spans', () => {
  let adapter: ClaudeAdapter;
  let now: number;

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    resetFakeAgents();
    mockDeliver.mockResolvedValue({ delivered: false, reason: 'not-bg' });
    now = 1_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    adapter = new ClaudeAdapter(() => {});
  });

  afterEach(async () => {
    await adapter.stopAll();
    jest.restoreAllMocks();
  });

  const init = (agent: number, sessionId: string) => fakeAgents[agent].emit({ type: 'system', subtype: 'init', session_id: sessionId });

  type Step = (() => void | Promise<void>);
  const cases: Array<{ name: string; steps: Step[]; session: string; at: number; had: boolean }> = [
    { name: 'no query yet', steps: [], session: 's', at: 1_000_000, had: false },
    { name: 'a new session, from its creation once the agent reports the id', steps: [() => adapter.startTask('t', 'go'), () => { now += 500; }, () => init(0, 's')], session: 's', at: 1_000_100, had: true },
    { name: 'a new session, before it was created', steps: [() => { now += 500; }, () => adapter.startTask('t', 'go'), () => init(0, 's')], session: 's', at: 1_000_100, had: false },
    { name: 'a new session, before its id is known', steps: [() => adapter.startTask('t', 'go')], session: 's', at: 1_000_100, had: false },
    { name: 'a resumed session, from the resume', steps: [() => adapter.resumeTask('t', 's', 'go')], session: 's', at: 1_000_000, had: true },
    { name: 'a resumed session, once its agent reports the same id', steps: [() => adapter.resumeTask('t', 's', 'go'), () => init(0, 's')], session: 's', at: 1_000_000, had: true },
    { name: 'a resumed session, later in its life', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 60_000; }], session: 's', at: 1_050_000, had: true },
    { name: 'a session whose agent has ended, after the end', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 1000; }, () => fakeAgents[0].end(), () => { now += 1000; }], session: 's', at: 1_001_500, had: false },
    { name: 'a session whose agent has ended, while it ran', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 1000; }, () => fakeAgents[0].end(), () => { now += 1000; }], session: 's', at: 1_000_500, had: true },
    { name: 'a session resumed twice, between the two agents', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 1000; }, () => fakeAgents[0].end(), () => { now += 1000; }, () => adapter.resumeTask('t', 's', 'again')], session: 's', at: 1_001_500, had: false },
    { name: 'a session resumed twice, during the second agent', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 1000; }, () => fakeAgents[0].end(), () => { now += 1000; }, () => adapter.resumeTask('t', 's', 'again'), () => { now += 1000; }], session: 's', at: 1_002_500, had: true },
    { name: 'a session stopped with the daemon, after the stop', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 1000; }, () => adapter.stopAll(), () => { now += 1000; }], session: 's', at: 1_001_500, had: false },
    { name: 'another session', steps: [() => adapter.resumeTask('t', 's', 'go')], session: 'other', at: 1_000_000, had: false },
    { name: 'a message handed to a background agent over its control socket', steps: [() => { mockDeliver.mockResolvedValue({ delivered: true }); }, () => adapter.resumeTask('t', 's', 'go')], session: 's', at: 1_000_000, had: false },
    { name: 'a session whose agent failed, after the failure', steps: [() => adapter.resumeTask('t', 's', 'go'), () => { now += 1000; }, () => fakeAgents[0].fail(new Error('boom')), () => { now += 1000; }], session: 's', at: 1_001_500, had: false },
  ];

  it.each(cases)('$name', async ({ steps, session, at, had }) => {
    for (const step of steps) {
      await step();
      await flush();
    }
    expect(adapter.hadQueryAt(session, at)).toBe(had);
  });
});
