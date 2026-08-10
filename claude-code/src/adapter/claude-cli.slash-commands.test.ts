/**
 * The CLI's `system`/`init` event is the daemon's only free source of the
 * project's slash commands. These tests drive a fake CLI process and assert the
 * adapter hands that list on, and stays silent when the event can't supply one.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));

import { spawn } from 'child_process';
import { ClaudeAdapter } from './claude-cli';

const spawnMock = spawn as unknown as jest.Mock;

interface FakeProc extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  kill: jest.Mock;
}

function makeFakeProc(): FakeProc {
  const proc = new EventEmitter() as FakeProc;
  proc.stdout = new Readable({ read() {} });
  proc.stderr = new Readable({ read() {} });
  proc.kill = jest.fn();
  return proc;
}

/** Feed one stream-json line to a task's CLI process and let readline drain. */
async function emit(proc: FakeProc, event: Record<string, unknown>): Promise<void> {
  proc.stdout.push(`${JSON.stringify(event)}\n`);
  await new Promise<void>((r) => setImmediate(r));
}

describe('slash commands from the init event', () => {
  let proc: FakeProc;
  let reported: Array<[string, string[]]>;
  let adapter: ClaudeAdapter;

  beforeEach(async () => {
    jest.spyOn(console, 'log').mockImplementation(() => {});
    proc = makeFakeProc();
    spawnMock.mockReturnValue(proc);
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
      name: 'stays silent when the CLI advertised nothing',
      event: { type: 'system', subtype: 'init', session_id: 's1', cwd: '/repo', slash_commands: [] },
      expected: [],
    },
    {
      name: 'stays silent without a working directory to key the set on',
      event: { type: 'system', subtype: 'init', session_id: 's1', slash_commands: ['compact'] },
      expected: [],
    },
    {
      name: 'stays silent for an older CLI that omits the field',
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
    await emit(proc, event);
    expect(reported).toEqual(expected);
  });

  test('an adapter with no callback still handles init', async () => {
    const bare = new ClaudeAdapter(() => {});
    const bareProc = makeFakeProc();
    spawnMock.mockReturnValue(bareProc);
    await bare.startTask('task-2', 'hello', undefined);

    await expect(
      emit(bareProc, { type: 'system', subtype: 'init', session_id: 's2', cwd: '/repo', slash_commands: ['compact'] }),
    ).resolves.toBeUndefined();

    await bare.stopAll();
  });
});
