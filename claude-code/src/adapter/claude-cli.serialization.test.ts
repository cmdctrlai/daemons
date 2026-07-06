/**
 * Integration test: resumeTask must serialize resumes of the same session so
 * two overlapping `claude --resume` processes can't fork the JSONL.
 *
 * Reality check that this test encodes: the daemon's task_id is per-session
 * (device:agent:sessionId), so every message for one session arrives with the
 * SAME task_id and replaces the previous entry in the `running` map. The
 * serialization must keep the queued message alive across that replacement and
 * the prior task's cleanup – an earlier version dropped it.
 *
 * The spawned process is mocked so we can assert exactly when each resume is
 * allowed to spawn relative to the previous one finishing.
 */

import { EventEmitter } from 'events';
import { Readable } from 'stream';

jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  spawn: jest.fn(),
}));
// Keep the post-exit entrypoint rewrite out of the test – it would scan the
// real ~/.claude/projects on close.
jest.mock('./entrypoint-rewrite', () => ({
  rewriteSdkCliEntrypoint: jest.fn(),
}));
// These tests assert on the `--resume` spawn path. Force the background-agent
// delivery check to report "not a bg session" so it stays hermetic (no reliance
// on a live Claude Code supervisor) and falls straight through to spawn.
jest.mock('./claude-daemon', () => ({
  deliverToBgSession: jest.fn().mockResolvedValue({ delivered: false, reason: 'not-bg' }),
}));

import { spawn } from 'child_process';
import { ClaudeAdapter } from './claude-cli';

const spawnMock = spawn as unknown as jest.Mock;
const flush = async () => {
  // Drain the microtask + immediate queues so chained mutex awaits settle.
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
};

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

function finish(proc: FakeProc, code = 0): void {
  // End the streams so readline closes, then signal exit.
  proc.stdout.push(null);
  proc.stderr.push(null);
  proc.emit('close', code);
}

// The daemon derives one task_id per session, so all messages for a session
// share it.
const taskFor = (session: string) => `dev:claude_code:${session}`;

describe('ClaudeAdapter resume serialization', () => {
  let procs: FakeProc[];

  beforeEach(() => {
    procs = [];
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const p = makeFakeProc();
      procs.push(p);
      return p;
    });
  });

  it('runs a queued second message for the same session (shared task_id) once the first exits', async () => {
    const adapter = new ClaudeAdapter(() => {});
    const task = taskFor('sess-A');
    const r1 = adapter.resumeTask(task, 'sess-A', 'sleep then done');
    const r2 = adapter.resumeTask(task, 'sess-A', 'what is 8+8');

    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1); // second is queued behind the first

    // First turn finishes -> its cleanup must NOT drop the queued second.
    finish(procs[0]);
    await r1;
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(2); // regression guard: second still runs

    finish(procs[1]);
    await r2;
  });

  it('spawns resumes for different sessions concurrently', async () => {
    const adapter = new ClaudeAdapter(() => {});
    const r1 = adapter.resumeTask(taskFor('sess-A'), 'sess-A', 'a');
    const r2 = adapter.resumeTask(taskFor('sess-B'), 'sess-B', 'b');

    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(2); // distinct sessions don't block

    procs.forEach((p) => finish(p));
    await Promise.all([r1, r2]);
  });

  it('drains a backlog of same-session messages in order, one at a time, dropping none', async () => {
    // Even when three messages for one session (shared task_id) pile up while
    // the first runs, each runs in turn – no message is lost.
    const adapter = new ClaudeAdapter(() => {});
    const task = taskFor('sess-A');
    const r1 = adapter.resumeTask(task, 'sess-A', '1');
    const r2 = adapter.resumeTask(task, 'sess-A', '2');
    const r3 = adapter.resumeTask(task, 'sess-A', '3');

    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(1); // only the first is running

    finish(procs[0]);
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(2); // second now runs

    finish(procs[1]);
    await flush();
    expect(spawnMock).toHaveBeenCalledTimes(3); // third now runs

    finish(procs[2]);
    await Promise.all([r1, r2, r3]);
  });
});
