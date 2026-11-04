import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os, { tmpdir } from 'os';
import { join } from 'path';
import type { DaemonIdentity } from './context';

// No real server, pi SDK or session store: only which agent the omp daemon picks.
jest.mock('@cmdctrl/daemon-sdk', () => {
  const actual = jest.requireActual('@cmdctrl/daemon-sdk');
  const fakeClient = () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (t, p) => {
        if (p === 'then') return undefined;
        if (!(p in t)) t[p] = p === 'connect' ? jest.fn().mockResolvedValue(undefined) : jest.fn();
        return t[p];
      },
    });
  return { ...actual, DaemonClient: jest.fn().mockImplementation(fakeClient) };
});
jest.mock('./pi-sdk', () => ({ piSdk: async () => ({ VERSION: '0.0.0' }) }));
jest.mock('./session-reader', () => ({
  ...jest.requireActual('./session-reader'),
  listReportedSessions: async () => [],
}));

const home = mkdtempSync(join(tmpdir(), 'cmdctrl-omp-isolation-'));
const omp: DaemonIdentity = { daemonName: 'omp', agentType: 'omp', bin: 'omp', version: '9.8.7' };
const saved = { PI_BIN: process.env.PI_BIN, OMP_BIN: process.env.OMP_BIN };

beforeEach(() => {
  jest.spyOn(os, 'homedir').mockReturnValue(home);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.PI_BIN;
  delete process.env.OMP_BIN;
  const dir = join(home, '.cmdctrl-omp');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:1', deviceId: 'dev-1', deviceName: 'host' }));
  writeFileSync(join(dir, 'credentials'), JSON.stringify({ refreshToken: 'tok' }));
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  rmSync(home, { recursive: true, force: true });
});

describe('cmdctrl-omp stays omp', () => {
  test('never reports pi sessions, even when the omp binary cannot be run', async () => {
    process.env.PI_BIN = join(home, 'no-such-omp');
    process.env.OMP_BIN = join(home, 'no-such-omp');
    let agent = '';
    await jest.isolateModulesAsync(async () => {
      require('./context').useIdentity(omp);
      await require('./commands/start').start();
      agent = require('./session-source').sessionSource().agent;
    });
    expect(agent).toBe('omp');
  });

  test('a PI_BIN exported for pi does not redirect it to pi', () => {
    // docs/installation/pi.md tells volta/fnm users to set PI_BIN to pi's path.
    process.env.PI_BIN = '/opt/pi/bin/pi';
    let bin = '';
    jest.isolateModules(() => {
      const ctx = require('./context');
      ctx.useIdentity(omp);
      bin = ctx.PI_BIN;
    });
    expect(bin).not.toBe('/opt/pi/bin/pi');
  });

  test('a failed omp turn names omp, not pi, in the error the app shows', async () => {
    const bin = join(home, 'fake-omp');
    writeFileSync(bin, '#!/bin/sh\necho "No default model selected." >&2\nexit 1\n', { mode: 0o755 });
    process.env.OMP_BIN = bin;
    let error = '';
    await jest.isolateModulesAsync(async () => {
      require('./context').useIdentity(omp);
      await require('./agent')
        .startTask('hi', home, () => {}, () => {})
        .catch((e: Error) => { error = e.message; });
    });
    expect(error).toContain('No default model selected.');
    expect(error).not.toMatch(/\bpi\b/);
  });
});

describe("what an omp turn or command probe reports names omp", () => {
  const cases: Array<{ name: string; script: string; act: 'turn' | 'probe'; want: string }> = [
    { name: 'a turn that never names its session', script: 'cat >/dev/null', act: 'turn', want: 'omp did not emit a session event' },
    { name: 'a turn with no assistant text', script: `cat >/dev/null\necho '{"type":"session","id":"s-omp"}'`, act: 'turn', want: '(omp produced no assistant text)' },
    { name: 'a probe that exits before answering', script: 'cat >/dev/null\necho boom >&2\nexit 2', act: 'probe', want: 'omp rpc exited with code 2 before answering: boom' },
  ];

  test.each(cases)('$name', async ({ script, act, want }) => {
    const bin = join(home, 'fake-omp');
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    process.env.OMP_BIN = bin;
    let got = '';
    await jest.isolateModulesAsync(async () => {
      require('./context').useIdentity(omp);
      const run: Promise<unknown> = act === 'turn'
        ? require('./agent').startTask('hi', home, () => {}, () => {}).then((r: { result: string }) => r.result)
        : require('./pi-commands').listCommands(home, 'omp');
      got = await run.then(String, (e: Error) => e.message);
    });
    expect(got).toContain(want);
    expect(got).not.toMatch(/\bpi\b/);
  });
});
