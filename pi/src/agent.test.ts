import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { header, message, titleSlot, writeSession } from './omp-session.fixture';

const T = (h: number) => `2026-11-01T${String(h).padStart(2, '0')}:00:00.000Z`;

/**
 * Turns per session run one at a time. A fake agent logs when each run starts and
 * ends; a prompt containing SLOW takes a second, FAIL exits non-zero with no output.
 */
describe('agent turns, one per session at a time', () => {
  let root: string;
  let log: string;
  let agent: typeof import('./agent');

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-turns-'));
    log = join(root, 'runs.log');
    for (const id of ['s1', 's2', 'snew']) writeSession(root, '--w--', id, [titleSlot(), header(id, root), message('u1', 'user', 'hi', T(10))]);
    const bin = join(root, 'fake-agent.sh');
    writeFileSync(bin, [
      '#!/bin/sh',
      'last=$(cat)',
      'session=snew; prev=; for a; do [ "$prev" = --session ] && session=$(basename "$a" .jsonl); prev=$a; done',
      `echo "start $session $last" >> '${log}'`,
      'echo "{\\"type\\":\\"session\\",\\"id\\":\\"$session\\"}"',
      'case "$last" in *FAIL*) exit 3;; esac',
      'case "$last" in *SLOW*) sleep 1;; esac',
      `echo "end $session $last" >> '${log}'`,
      'echo "{\\"type\\":\\"message_end\\",\\"message\\":{\\"role\\":\\"assistant\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"ok $last\\"}]}}"',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.PI_BIN = bin;
    jest.isolateModules(() => {
      agent = require('./agent');
      const source: typeof import('./session-source') = require('./session-source');
      source.useSessionSource(source.ompSessions(root));
    });
    delete process.env.PI_BIN;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const runs = () => readFileSync(log, 'utf-8').trim().split('\n');
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
  const noop = () => {};

  const cases: Array<{ name: string; act: () => Promise<unknown>; want: string[] }> = [
    {
      name: 'follow-ups run in the order they arrived, each after the one before',
      act: async () => {
        const a = agent.resumeTask('s1', 'one SLOW', root, noop);
        await wait(200);
        const b = agent.resumeTask('s1', 'two', root, noop);
        const c = agent.resumeTask('s1', 'three', root, noop);
        await Promise.all([a, b, c]);
      },
      want: ['start s1 one SLOW', 'end s1 one SLOW', 'start s1 two', 'end s1 two', 'start s1 three', 'end s1 three'],
    },
    {
      name: 'a follow-up waits for the turn that started the session',
      act: async () => {
        let started!: () => void;
        const known = new Promise<void>(r => { started = r; });
        const first = agent.startTask('first SLOW', root, noop, () => started());
        await known;
        await Promise.all([first, agent.resumeTask('snew', 'next', root, noop)]);
      },
      want: ['start snew first SLOW', 'end snew first SLOW', 'start snew next', 'end snew next'],
    },
    {
      name: 'a turn that fails does not hold up the next',
      act: async () => {
        const failed = agent.resumeTask('s1', 'FAIL', root, noop).catch(e => e);
        await Promise.all([failed, agent.resumeTask('s1', 'after', root, noop)]);
        expect(String(await failed)).toMatch(/exited with code 3/);
      },
      want: ['start s1 FAIL', 'start s1 after', 'end s1 after'],
    },
  ];

  test.each(cases)('$name', async ({ act, want }) => {
    await act();
    expect(runs()).toEqual(want);
  });

  // Process start-up order is the scheduler's business; what matters is that the
  // quick turn on another session finishes while the long one is still running.
  it('different sessions do not wait for each other', async () => {
    const a = agent.resumeTask('s1', 'long SLOW', root, noop);
    await wait(200);
    await agent.resumeTask('s2', 'quick', root, noop);
    await a;
    const order = runs();
    expect(order.indexOf('end s2 quick')).toBeLessThan(order.indexOf('end s1 long SLOW'));
    expect(order.filter(l => l.startsWith('start')).sort()).toEqual(['start s1 long SLOW', 'start s2 quick']);
  });

  it('Stop ends the running turn and drops the follow-up waiting behind it; a later one runs', async () => {
    const running = agent.resumeTask('s1', 'long SLOW', root, noop).catch(e => e);
    await wait(200);
    const waiting = agent.resumeTask('s1', 'queued', root, noop).catch(e => e);
    agent.cancelTask('s1');
    const later = agent.resumeTask('s1', 'after stop', root, noop);
    const [, dropped] = await Promise.all([running, waiting, later]);
    expect(String(dropped)).toMatch(/^Error: Not sent: the session was stopped/);
    // The stopped turn never reached its end; the queued one never started.
    expect(runs()).toEqual(['start s1 long SLOW', 'start s1 after stop', 'end s1 after stop']);
  });
});

describe('Stop on an agent that ignores SIGTERM', () => {
  let root: string;
  let agent: typeof import('./agent');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-hang-'));
    writeSession(root, '--w--', 's1', [titleSlot(), header('s1', root), message('u1', 'user', 'hi', T(10))]);
    const bin = join(root, 'stubborn-agent.js');
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      'const last = require("fs").readFileSync(0, "utf-8");',
      'console.log(JSON.stringify({ type: "session", id: "s1" }));',
      'if (last === "HANG") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }',
      'else console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok " + last }] } }));',
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.PI_BIN = bin;
    jest.isolateModules(() => {
      agent = require('./agent');
      const source: typeof import('./session-source') = require('./session-source');
      source.useSessionSource(source.ompSessions(root));
    });
    delete process.env.PI_BIN;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('is killed, so the session\'s next message still runs', async () => {
    const hung = agent.resumeTask('s1', 'HANG', root, () => {}).catch(e => e);
    await new Promise(r => setTimeout(r, 300));
    agent.cancelTask('s1');
    const next = await agent.resumeTask('s1', 'after', root, () => {});
    await hung;
    expect(next.result).toBe('ok after');
  });
});

describe('an agent that exits without reading the message', () => {
  let root: string;
  let agent: typeof import('./agent');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-noread-'));
    writeSession(root, '--w--', 's1', [titleSlot(), header('s1', root), message('u1', 'user', 'hi', T(10))]);
    const bin = join(root, 'early-exit.sh');
    writeFileSync(bin, '#!/bin/sh\necho "Error: no credentials" >&2\nexit 4\n');
    chmodSync(bin, 0o755);
    process.env.PI_BIN = bin;
    jest.isolateModules(() => {
      agent = require('./agent');
      const source: typeof import('./session-source') = require('./session-source');
      source.useSessionSource(source.ompSessions(root));
    });
    delete process.env.PI_BIN;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // A message bigger than the pipe buffer is still being written when the agent exits.
  it('fails the turn with the agent\'s own error instead of crashing on the closed pipe', async () => {
    await expect(agent.resumeTask('s1', 'x'.repeat(4 * 1024 * 1024), root, () => {}))
      .rejects.toThrow('pi exited with code 4: Error: no credentials');
  });
});

describe('a model call that fails', () => {
  const MODEL_ERROR = "Codex error: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.";
  let root: string;
  let agent: typeof import('./agent');
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'agent-model-error-'));
    writeSession(root, '--w--', 's1', [titleSlot(), header('s1', root), message('u1', 'user', 'hi', T(10))]);
    // pi's json mode exits 0 after a failed model call; the error is only on the assistant message.
    const bin = join(root, 'model-error.js');
    writeFileSync(bin, [
      '#!/usr/bin/env node',
      'require("fs").readFileSync(0);',
      'const s = process.argv.indexOf("--session");',
      'const id = s < 0 ? "snew" : require("path").basename(process.argv[s + 1], ".jsonl");',
      'console.log(JSON.stringify({ type: "session", id }));',
      `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: ${JSON.stringify(MODEL_ERROR)} } }));`,
    ].join('\n'));
    chmodSync(bin, 0o755);
    process.env.PI_BIN = bin;
    jest.isolateModules(() => {
      agent = require('./agent');
      const source: typeof import('./session-source') = require('./session-source');
      source.useSessionSource(source.ompSessions(root));
    });
    delete process.env.PI_BIN;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const cases: Array<{ name: string; run: () => Promise<unknown> }> = [
    { name: 'fails a new session\'s turn with the model\'s error', run: () => agent.startTask('hi', root, () => {}, () => {}) },
    { name: 'fails a resumed session\'s turn with the model\'s error', run: () => agent.resumeTask('s1', 'hi', root, () => {}) },
  ];

  test.each(cases)('$name', async ({ run }) => {
    await expect(run()).rejects.toThrow(MODEL_ERROR);
  });
});
