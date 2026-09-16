/**
 * The agent's `system`/`init` event is the daemon's only free source of the
 * project's slash commands. These tests drive a fake agent and assert the
 * adapter hands that list on, and stays silent when the event can't supply one.
 */

jest.mock('@anthropic-ai/claude-agent-sdk', () => require('./__mocks__/fake-agent-sdk'));
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));

import { ClaudeAdapter } from './claude-cli';
import { fakeAgents, resetFakeAgents, flush } from './__mocks__/fake-agent-sdk';

describe('slash commands from the init event', () => {
  let reported: Array<[string, string[]]>;
  let adapter: ClaudeAdapter;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    resetFakeAgents();
    reported = [];
    adapter = new ClaudeAdapter(
      () => {},
      (project, commands) => reported.push([project, commands]),
    );
    await adapter.startTask('task-1', 'hello', undefined);
  });

  afterEach(async () => {
    await adapter.stopAll();
    jest.restoreAllMocks();
  });

  const cases: Array<{ name: string; event: Record<string, unknown>; expected: Array<[string, string[]]> }> = [
    {
      name: 'reports the advertised list against the run working directory',
      event: { type: 'system', subtype: 'init', session_id: 's1', cwd: '/repo', slash_commands: ['compact', 'model'] },
      expected: [['/repo', ['compact', 'model']]],
    },
    {
      name: 'stays silent when the agent advertised nothing',
      event: { type: 'system', subtype: 'init', session_id: 's1', cwd: '/repo', slash_commands: [] },
      expected: [],
    },
    {
      name: 'stays silent without a working directory to key the set on',
      event: { type: 'system', subtype: 'init', session_id: 's1', slash_commands: ['compact'] },
      expected: [],
    },
    {
      name: 'stays silent for an older agent that omits the field',
      event: { type: 'system', subtype: 'init', session_id: 's1', cwd: '/repo' },
      expected: [],
    },
    {
      name: 'ignores non-init system events',
      event: { type: 'system', subtype: 'other', cwd: '/repo', slash_commands: ['compact'] },
      expected: [],
    },
  ];

  test.each(cases)('$name', async ({ event, expected }) => {
    fakeAgents[0].emit(event);
    await flush();
    expect(reported).toEqual(expected);
  });

  test('an adapter with no callback still handles init', async () => {
    const bare = new ClaudeAdapter(() => {});
    await bare.startTask('task-2', 'hello', undefined);

    fakeAgents[1].emit({ type: 'system', subtype: 'init', session_id: 's2', cwd: '/repo', slash_commands: ['compact'] });
    await expect(flush()).resolves.toBeUndefined();

    await bare.stopAll();
  });
});
