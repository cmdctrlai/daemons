/**
 * A message arriving while a question is open is only sometimes the answer.
 * Slash commands and messages carrying images are not – routing them into the
 * tool call would execute nothing and drop the pictures on the floor. These
 * tests park a real question through `canUseTool` and assert where each kind
 * of follow-up message lands.
 */

jest.mock('@anthropic-ai/claude-agent-sdk', () => require('./__mocks__/fake-agent-sdk'));
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));
jest.mock('./claude-daemon', () => ({
  deliverToBgSession: jest.fn().mockResolvedValue({ delivered: false, reason: 'not-bg' }),
}));

import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeAdapter } from './claude-cli';
import { fakeAgents, resetFakeAgents, flush } from './__mocks__/fake-agent-sdk';

const SESSION = 'sess-A';
const TASK = `dev:claude_code:${SESSION}`;
const PNG = 'data:image/png;base64,aGVsbG8=';

const ASK_INPUT = {
  questions: [{ question: 'Theme?', options: [{ label: 'Light' }, { label: 'Dark' }] }],
};

/**
 * Starts a session and parks an AskUserQuestion on it. The parked promise is
 * wrapped, since awaiting it directly would wait for the answer that has not
 * been sent yet.
 */
async function parkQuestion(
  adapter: ClaudeAdapter,
  input: Record<string, unknown> = ASK_INPUT
): Promise<{ parked: Promise<PermissionResult> }> {
  await adapter.resumeTask(TASK, SESSION, 'hello');
  await flush();

  const canUseTool = fakeAgents[0].options.canUseTool as (
    tool: string,
    input: Record<string, unknown>
  ) => Promise<PermissionResult>;
  const parked = canUseTool('AskUserQuestion', input);
  await flush();
  return { parked };
}

describe('ClaudeAdapter answer routing', () => {
  let adapter: ClaudeAdapter;
  let events: { type: string; data: Record<string, unknown> }[];

  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    resetFakeAgents();
    events = [];
    adapter = new ClaudeAdapter((_taskId, type, data) => events.push({ type, data }));
  });

  afterEach(async () => {
    await adapter.stopAll();
    jest.restoreAllMocks();
  });

  const cases: {
    name: string;
    message: string;
    images?: string[];
    answered: boolean;
  }[] = [
    { name: 'an offered label answers the question', message: 'Light', answered: true },
    { name: 'free text answers it too, as the CLI\'s own Other path does', message: 'something else', answered: true },
    { name: 'a path is not a command and still answers', message: '/usr/local/bin', answered: true },
    { name: 'a slash command is an instruction, not a choice', message: '/compact', answered: false },
    { name: 'a slash command with arguments likewise', message: '/pjm bug the thing broke', answered: false },
    { name: 'a namespaced slash command likewise', message: '/project:deploy', answered: false },
    { name: 'an image is never an answer', message: 'Light', images: [PNG], answered: false },
  ];

  for (const c of cases) {
    it(c.name, async () => {
      const { parked } = await parkQuestion(adapter);

      await adapter.resumeTask(TASK, SESSION, c.message, undefined, c.images);
      await flush();

      const result = await parked;
      expect(result.behavior).toBe(c.answered ? 'allow' : 'deny');
      // An answer is consumed by the tool call; anything else reaches the agent
      // as an ordinary turn.
      expect(fakeAgents[0].sent).toEqual(c.answered ? ['hello'] : ['hello', c.message]);
    });
  }

  // A question may well offer a path as a choice. Tapping it is unambiguous,
  // however much the label reads like a command.
  it('an offered label wins over the slash-command rule', async () => {
    const { parked } = await parkQuestion(adapter, {
      questions: [{ question: 'Where?', options: [{ label: '/tmp' }, { label: '/var' }] }],
    });

    await adapter.resumeTask(TASK, SESSION, '/tmp');
    await flush();

    expect((await parked).behavior).toBe('allow');
    expect(fakeAgents[0].sent).toEqual(['hello']);
  });

  // Releasing a question denies the tool call, and the SDK books that on the
  // turn's result. Treating it as a permission request would ask the user to
  // approve the very tool that exists to ask them something.
  it('a released question does not resurface as a permission prompt', async () => {
    const { parked } = await parkQuestion(adapter);

    await adapter.resumeTask(TASK, SESSION, '/compact');
    await flush();
    await parked;

    events.length = 0;
    fakeAgents[0].emit({
      type: 'result',
      result: 'done',
      permission_denials: [{ tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: {} }],
    });
    await flush();

    expect(events.map((e) => e.type)).toEqual(['TASK_COMPLETE']);
  });

  it('still asks for permission when another tool was denied', async () => {
    const { parked } = await parkQuestion(adapter);

    await adapter.resumeTask(TASK, SESSION, '/compact');
    await flush();
    await parked;

    events.length = 0;
    fakeAgents[0].emit({
      type: 'result',
      result: 'done',
      permission_denials: [
        { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: {} },
        { tool_name: 'Bash', tool_use_id: 'toolu_2', tool_input: {} },
      ],
    });
    await flush();

    expect(events.map((e) => e.type)).toEqual(['WAIT_FOR_USER']);
    expect(events[0].data.permission_tool).toBe('Bash');
  });

  it('keeps the images on a message that released the question', async () => {
    const { parked } = await parkQuestion(adapter);

    await adapter.resumeTask(TASK, SESSION, 'look at this', undefined, [PNG]);
    await flush();
    await parked;

    const last = fakeAgents[0].raw.at(-1) as { message: { content: { type: string }[] } };
    expect(last.message.content.map((b) => b.type)).toEqual(['image', 'text']);
  });
});
