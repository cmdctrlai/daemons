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
  const real = (qs: unknown[]) => ({ questions: qs });
  const opt = (label: string, extra: Record<string, unknown> = {}) => ({ label, description: `about ${label}`, ...extra });
  const cases: Array<{ name: string; input: unknown; prompt: string }> = [
    { name: 'full schema, header + descriptions', input: real([{ question: 'Which lib?', header: 'Library', multiSelect: false, options: [opt('date-fns'), opt('dayjs')] }]), prompt: 'Which lib?' },
    { name: 'multiSelect, 4 options with preview', input: real([{ question: 'Which features?', header: 'Features', multiSelect: true, options: [opt('A', { preview: '```ts\nx\n```' }), opt('B'), opt('C'), opt('D')] }]), prompt: 'Which features?' },
    { name: '4 questions', input: real([1,2,3,4].map((i) => ({ question: `Q${i}?`, header: 'H', multiSelect: false, options: [opt('yes'), opt('no')] }))), prompt: 'Q1?' },
    { name: 'unicode/emoji labels', input: real([{ question: '¿Qué? 🚀', header: 'x', multiSelect: false, options: [opt('Sí ✅'), opt('No ❌')] }]), prompt: '¿Qué? 🚀' },
    { name: 'extra unknown fields', input: { ...real([{ question: 'Go?', header: 'x', multiSelect: false, options: [opt('a'), opt('b')] }]), metadata: { source: 'x' }, answers: {} }, prompt: 'Go?' },
    { name: 'later question malformed', input: real([{ question: 'First?', header: 'x', multiSelect: false, options: [opt('a'), opt('b')] }, 'garbage']), prompt: 'First?' },
    { name: 'description missing', input: real([{ question: 'Ok?', options: [{ label: 'a' }, { label: 'b' }] }]), prompt: 'Ok?' },
  ];
  it.each(cases)('well-formed: $name is surfaced and parked, not denied', async ({ input, prompt }) => {
    const { result } = await ask('dev:claude_code:sess-r', 'sess-r', input);
    const waits = events.filter((e) => e.type === 'WAIT_FOR_USER');
    expect(waits).toHaveLength(1);
    expect(waits[0].data.prompt).toBe(prompt);
    let settled = false;
    result.then(() => { settled = true; });
    await flush();
    expect(settled).toBe(false);
  });
});
