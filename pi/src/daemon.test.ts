import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import os, { tmpdir } from 'os';
import { join } from 'path';
import type { DaemonIdentity } from './context';

type Context = typeof import('./context');
type Start = typeof import('./commands/start');

const home = mkdtempSync(join(tmpdir(), 'cmdctrl-identity-'));
const BIN_VARS = ['PI_BIN', 'OMP_BIN'];
const saved = Object.fromEntries(BIN_VARS.map((k) => [k, process.env[k]]));
const piVersion: string = require('../package.json').version;
const omp: DaemonIdentity = { daemonName: 'omp', agentType: 'omp', bin: 'omp', version: '9.8.7' };

// Jest's process.env is a copy that os.homedir() never sees, so stub it: no
// case may read or write the real ~/.cmdctrl-*.
beforeEach(() => {
  jest.spyOn(os, 'homedir').mockReturnValue(home);
  for (const k of BIN_VARS) delete process.env[k];
});

afterEach(() => jest.restoreAllMocks());

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(home, { recursive: true, force: true });
});

/** Fresh module graph, so each case starts from the default identity. */
function load(identity?: DaemonIdentity): { ctx: Context; start: Start } {
  let ctx!: Context;
  let start!: Start;
  jest.isolateModules(() => {
    ctx = require('./context');
    start = require('./commands/start');
    if (identity) ctx.useIdentity(identity);
  });
  return { ctx, start };
}

describe('daemon identity', () => {
  const cases: Array<{
    name: string;
    identity?: DaemonIdentity;
    env?: Record<string, string>;
    want: { agentType: string; cli: string; pkg: string; bin: string; configDir: string; version: string };
  }> = [
    {
      name: 'cmdctrl-pi by default',
      want: { agentType: 'pi', cli: 'cmdctrl-pi', pkg: '@cmdctrl/pi', bin: 'pi', configDir: join(home, '.cmdctrl-pi'), version: piVersion },
    },
    {
      name: 'cmdctrl-omp',
      identity: omp,
      want: { agentType: 'omp', cli: 'cmdctrl-omp', pkg: '@cmdctrl/omp', bin: 'omp', configDir: join(home, '.cmdctrl-omp'), version: '9.8.7' },
    },
    {
      name: 'an explicit configDir',
      identity: { ...omp, configDir: join(home, 'elsewhere') },
      want: { agentType: 'omp', cli: 'cmdctrl-omp', pkg: '@cmdctrl/omp', bin: 'omp', configDir: join(home, 'elsewhere'), version: '9.8.7' },
    },
    {
      name: "PI_BIN overriding pi's bin",
      env: { PI_BIN: '/opt/pi/bin/pi', OMP_BIN: '/opt/omp/bin/omp' },
      want: { agentType: 'pi', cli: 'cmdctrl-pi', pkg: '@cmdctrl/pi', bin: '/opt/pi/bin/pi', configDir: join(home, '.cmdctrl-pi'), version: piVersion },
    },
    {
      name: "OMP_BIN overriding omp's bin",
      identity: omp,
      env: { PI_BIN: '/opt/pi/bin/pi', OMP_BIN: '/opt/omp/bin/omp' },
      want: { agentType: 'omp', cli: 'cmdctrl-omp', pkg: '@cmdctrl/omp', bin: '/opt/omp/bin/omp', configDir: join(home, '.cmdctrl-omp'), version: '9.8.7' },
    },
  ];

  test.each(cases)('$name', ({ identity, env, want }) => {
    Object.assign(process.env, env);
    const { ctx, start } = load(identity);

    expect({
      agentType: ctx.AGENT_TYPE,
      cli: ctx.CLI_NAME,
      pkg: ctx.PACKAGE_NAME,
      bin: ctx.PI_BIN,
      configDir: ctx.config.configDir,
      version: ctx.DAEMON_VERSION,
    }).toEqual(want);

    const opts = start.clientOptions(
      { serverUrl: 'http://localhost:1', deviceId: 'dev-1', deviceName: 'host' },
      { refreshToken: 'tok' },
    );
    expect(opts).toMatchObject({
      agentType: want.agentType,
      version: want.version,
      autoUpdate: true,
      autoUpdateConfig: { packageName: want.pkg, binName: want.cli },
    });
  });
});

describe('runDaemon', () => {
  let log: jest.SpyInstance;
  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('importing the entry point runs no command', () => {
    jest.isolateModules(() => require('./daemon'));
    expect(log).not.toHaveBeenCalled();
  });

  test('commands speak as the identity they run under', () => {
    jest.isolateModules(() => {
      require('./daemon').runDaemon(omp, ['node', 'cmdctrl-omp', 'status']);
    });
    expect(log.mock.calls.flat().join('\n')).toContain('Run: cmdctrl-omp register -s <server-url>');
  });
});

describe("start refuses the other agent's CLI", () => {
  /** A registered daemon under `identity` whose CLI answers `--version` like `version`. */
  function registered(identity: DaemonIdentity, version: string): void {
    const dir = join(home, `.cmdctrl-${identity.daemonName}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ serverUrl: 'http://127.0.0.1:1', deviceId: 'dev-1', deviceName: 'host' }));
    writeFileSync(join(dir, 'credentials'), JSON.stringify({ refreshToken: 'tok' }));
    const cli = join(home, `fake-${identity.daemonName}`);
    writeFileSync(cli, `#!/bin/sh\necho '${version}' >&2\n`);
    chmodSync(cli, 0o755);
    process.env[identity.agentType === 'omp' ? 'OMP_BIN' : 'PI_BIN'] = cli;
  }

  const pi: DaemonIdentity = { daemonName: 'pi', agentType: 'pi', bin: 'pi', version: '1.0.0' };
  const cases = [
    { name: 'cmdctrl-pi driving omp', identity: pi, version: 'omp/18.16.0', want: 'but cmdctrl-pi drives pi. Point PI_BIN at pi, or use @cmdctrl/omp for omp.' },
    { name: 'cmdctrl-omp driving pi', identity: omp, version: '0.70.2', want: 'but cmdctrl-omp drives omp. Point OMP_BIN at omp, or use @cmdctrl/pi for pi.' },
  ];

  test.each(cases)('$name', async ({ identity, version, want }) => {
    registered(identity, version);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);

    const { start } = load(identity);
    await expect(start.start()).rejects.toThrow('exit 1');
    expect(error.mock.calls.flat().join('\n')).toContain(want);
  });
});
