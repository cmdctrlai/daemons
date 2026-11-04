import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { listReportedSessions } from './session-reader';
import { ompSessions, piSessions, useSessionSource } from './session-source';
import { header, message, titleSlot, writeSession } from './omp-session.fixture';

const T = (h: number) => `2026-11-01T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('refute r3: a diverged omp continuation in the session list', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omp-r3-'));
    useSessionSource(ompSessions(root));
  });
  afterEach(() => {
    useSessionSource(piSessions);
    rmSync(root, { recursive: true, force: true });
  });

  // omp's #moveOffSessionFile carries the header (title, titleSource) into the
  // continuation and rewrites the title slot with the session's name, so a
  // terminal session that was named – interactive omp auto-titles every one –
  // hands its title to the phone's continuation.
  it('does not list the phone continuation under the title it carried from the terminal session', async () => {
    writeSession(root, '--w--', 'orig', [
      titleSlot('Terminal Work'), header('orig', '/work/proj', { title: 'Terminal Work', titleSource: 'auto' }),
      message('u1', 'user', 'terminal first', T(10)), message('a1', 'assistant', 'ok', T(10)),
      message('u3', 'user', 'say TERMINAL-THIRD', T(12)), message('a3', 'assistant', 'ok', T(12)),
    ]);
    writeSession(root, '--w--', 'cont', [
      titleSlot('Terminal Work'),
      header('cont', '/work/proj', { continuationOf: 'orig', parentSession: 'orig', title: 'Terminal Work', titleSource: 'auto' }),
      message('u1', 'user', 'terminal first', T(10)), message('a1', 'assistant', 'ok', T(10)),
      message('u2', 'user', 'say PHONE-OK', T(11)), message('a2', 'assistant', 'ok', T(11)),
    ]);

    const titles = (await listReportedSessions()).map(s => [s.session_id, s.title]);

    expect(titles).toEqual([['orig', 'Terminal Work'], ['cont', 'say PHONE-OK']]);
  });
});

// The app's composer stays enabled while a turn runs, and the API forwards every
// send, so a follow-up typed mid-turn reaches resumeTask while the first omp is
// still writing. omp then finds the session held and moves the follow-up to a
// continuation; once the first turn lands in the original the two have diverged,
// and the follow-up leaves the thread for an entry of its own.
describe('refute r3: a follow-up sent while a turn runs', () => {
  let root: string;
  let log: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'omp-r3-run-'));
    log = join(root, 'runs.log');
    useSessionSource(ompSessions(root));
  });
  afterEach(() => {
    useSessionSource(piSessions);
    rmSync(root, { recursive: true, force: true });
  });

  it('does not run a second agent process on the session until the first exits', async () => {
    writeSession(root, '--w--', 's1', [titleSlot(), header('s1', root), message('u1', 'user', 'hi', T(10))]);
    const bin = join(root, 'fake-omp.sh');
    writeFileSync(bin, [
      '#!/bin/sh',
      'last=$(cat)',
      `echo "start $last" >> '${log}'`,
      'echo \'{"type":"session","id":"s1"}\'',
      'case "$last" in *SLOW*) sleep 1;; esac',
      `echo "end $last" >> '${log}'`,
    ].join('\n'));
    chmodSync(bin, 0o755);

    let agent!: typeof import('./agent');
    process.env.PI_BIN = bin;
    jest.isolateModules(() => {
      agent = require('./agent');
      const source: typeof import('./session-source') = require('./session-source');
      source.useSessionSource(source.ompSessions(root));
    });
    delete process.env.PI_BIN;

    const first = agent.resumeTask('s1', 'go SLOW', root, () => {});
    await new Promise(r => setTimeout(r, 300));
    const second = agent.resumeTask('s1', 'follow-up', root, () => {});
    await Promise.all([first, second]);

    expect(readFileSync(log, 'utf-8').trim().split('\n')).toEqual([
      'start go SLOW', 'end go SLOW', 'start follow-up', 'end follow-up',
    ]);
  });
});
