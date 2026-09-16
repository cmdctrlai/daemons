/**
 * A question parked on someone's phone produces no stream events, so the turn
 * watchdog has to stand down or it interrupts the session and denies the tool
 * call while the user is still deciding. These tests drive the clock forward
 * and assert what the adapter reports.
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

const TEN_MINUTES = 10 * 60 * 1000;
const ONE_HOUR = 60 * 60 * 1000;

const askInput = {
  questions: [
    {
      question: 'Tabs or spaces?',
      header: 'Style',
      multiSelect: false,
      options: [{ label: 'Tabs' }, { label: 'Spaces' }],
    },
  ],
};

type Event = { taskId: string; type: string; data: Record<string, unknown> };

describe('parked question vs the turn watchdog', () => {
  let adapter: ClaudeAdapter;
  let events: Event[];

  const errorsFor = (taskId: string) =>
    events.filter((e) => e.taskId === taskId && e.type === 'ERROR');

  /** Start a turn on `session` and park a question on it. */
  const parkQuestion = async (session: string, taskId: string) => {
    await adapter.resumeTask(taskId, session, 'do the thing');
    await flush();
    const agent = fakeAgents[fakeAgents.length - 1];
    const canUseTool = agent.options.canUseTool as (
      name: string,
      input: Record<string, unknown>
    ) => Promise<unknown>;
    const parked = canUseTool('AskUserQuestion', askInput as unknown as Record<string, unknown>);
    await flush();
    return { agent, parked };
  };

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

  const cases: Array<{ name: string; advanceMs: number; wantError: boolean }> = [
    { name: 'survives the ordinary turn timeout', advanceMs: TEN_MINUTES + 1000, wantError: false },
    { name: 'survives most of the question budget', advanceMs: ONE_HOUR - 1000, wantError: false },
    { name: 'gives up once the question budget runs out', advanceMs: ONE_HOUR + 1000, wantError: true },
  ];

  it.each(cases)('$name', async ({ advanceMs, wantError }) => {
    const task = 'dev:claude_code:sess-q';
    const { parked } = await parkQuestion('sess-q', task);

    jest.advanceTimersByTime(advanceMs);
    await flush();

    expect(errorsFor(task).length > 0).toBe(wantError);
    if (wantError) {
      expect(errorsFor(task)[0].data.error).toBe('execution timeout');
      await expect(parked).resolves.toMatchObject({ behavior: 'deny' });
    }
  });

  it('reports the question to the app before parking it', async () => {
    const task = 'dev:claude_code:sess-w';
    await parkQuestion('sess-w', task);

    const wait = events.find((e) => e.taskId === task && e.type === 'WAIT_FOR_USER');
    expect(wait?.data.prompt).toBe('Tabs or spaces?');
    expect(wait?.data.permission_tool).toBe('AskUserQuestion');
  });

  it('hands the watchdog to the answering task instead of leaving it to fire', async () => {
    const first = 'dev:claude_code:sess-a#1';
    const second = 'dev:claude_code:sess-a#2';
    const { parked } = await parkQuestion('sess-a', first);

    await adapter.resumeTask(second, 'sess-a', 'Tabs');
    await flush();
    await expect(parked).resolves.toMatchObject({ behavior: 'allow' });

    // The old task is nobody's turn any more; its timer must not outlive it.
    jest.advanceTimersByTime(ONE_HOUR + TEN_MINUTES);
    await flush();

    expect(errorsFor(first)).toEqual([]);
  });

  it('gives a mid-turn second message the same handover', async () => {
    const first = 'dev:claude_code:sess-b#1';
    const second = 'dev:claude_code:sess-b#2';
    await adapter.resumeTask(first, 'sess-b', 'count to twenty');
    await flush();
    await adapter.resumeTask(second, 'sess-b', 'stop counting');
    await flush();

    jest.advanceTimersByTime(TEN_MINUTES + 1000);
    await flush();

    expect(errorsFor(first)).toEqual([]);
    expect(errorsFor(second).map((e) => e.data.error)).toEqual(['execution timeout']);
  });
});
