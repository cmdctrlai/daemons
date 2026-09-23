/**
 * A malformed AskUserQuestion used to reach the app as an empty notification:
 * `questions` arriving as the raw JSON string indexes to the character "[",
 * which is truthy and has no question text. These tests drive the real
 * permission callback and assert nothing is surfaced and the call is denied
 * rather than parked for the whole question budget.
 */

jest.mock('@anthropic-ai/claude-agent-sdk', () => require('./__mocks__/fake-agent-sdk'));
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));
jest.mock('./claude-daemon', () => ({
  deliverToBgSession: jest.fn().mockResolvedValue({ delivered: false, reason: 'not-bg' }),
}));

import { ClaudeAdapter } from './claude-cli';
import { fakeAgents, resetFakeAgents, flush } from './__mocks__/fake-agent-sdk';

type Event = { taskId: string; type: string; data: Record<string, unknown> };

const wellFormed = {
  questions: [
    { question: 'Tabs or spaces?', options: [{ label: 'Tabs' }, { label: 'Spaces' }] },
  ],
};

describe('AskUserQuestion with unusable input', () => {
  let adapter: ClaudeAdapter;
  let events: Event[];

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    resetFakeAgents();
    events = [];
    adapter = new ClaudeAdapter((taskId, type, data) => {
      events.push({ taskId, type, data: (data ?? {}) as Record<string, unknown> });
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    await adapter.stopAll();
    jest.restoreAllMocks();
  });

  /** Start a turn and hand the agent's permission callback one tool input. */
  const ask = async (taskId: string, session: string, input: unknown) => {
    await adapter.resumeTask(taskId, session, 'do the thing');
    await flush();
    const agent = fakeAgents[fakeAgents.length - 1];
    const canUseTool = agent.options.canUseTool as (
      name: string,
      input: Record<string, unknown>
    ) => Promise<{ behavior: string; message?: string }>;
    // Wrapped, not returned bare: an async function would await the promise,
    // and a well-formed question parks until someone answers.
    const result = canUseTool('AskUserQuestion', input as Record<string, unknown>);
    await flush();
    return { result };
  };

  const malformed: Array<{ name: string; input: unknown }> = [
    { name: 'questions as the raw JSON string', input: { questions: JSON.stringify(wellFormed.questions) } },
    { name: 'questions as an empty array', input: { questions: [] } },
    { name: 'questions missing entirely', input: {} },
    { name: 'questions as an object', input: { questions: { question: 'hi' } } },
    { name: 'first question with no text', input: { questions: [{ options: [{ label: 'a' }] }] } },
    { name: 'first question blank', input: { questions: [{ question: '   ', options: [{ label: 'a' }] }] } },
    { name: 'options as the raw JSON string', input: { questions: [{ question: 'Tabs?', options: '[{"label":"Tabs"}]' }] } },
    { name: 'options empty', input: { questions: [{ question: 'Tabs?', options: [] }] } },
    { name: 'options missing', input: { questions: [{ question: 'Tabs?' }] } },
    { name: 'an option that is null', input: { questions: [{ question: 'Tabs?', options: [{ label: 'Tabs' }, null] }] } },
    { name: 'an option with no label', input: { questions: [{ question: 'Tabs?', options: [{}] }] } },
  ];

  it.each(malformed)('$name surfaces nothing and is denied', async ({ input }) => {
    const task = 'dev:claude_code:sess-bad';
    const { result } = await ask(task, 'sess-bad', input);

    expect(events.filter((e) => e.type === 'WAIT_FOR_USER')).toHaveLength(0);
    expect((await result).behavior).toBe('deny');
  });

  it('still surfaces a well-formed question', async () => {
    const task = 'dev:claude_code:sess-ok';
    await ask(task, 'sess-ok', wellFormed);

    const waits = events.filter((e) => e.type === 'WAIT_FOR_USER');
    expect(waits).toHaveLength(1);
    expect(waits[0].data.prompt).toBe('Tabs or spaces?');
    expect(waits[0].data.options).toEqual([{ label: 'Tabs' }, { label: 'Spaces' }]);
  });
});
