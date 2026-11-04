import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { flavorFromVersion, ompAgentDir, ompSessionsRoot, type AgentFlavor } from './agent-flavor';

describe('flavorFromVersion', () => {
  const cases: Array<{ name: string; output: string; want: AgentFlavor }> = [
    { name: 'omp prints omp/<version>', output: 'omp/18.15.0', want: 'omp' },
    { name: 'omp with a trailing newline', output: 'omp/18.15.0\n', want: 'omp' },
    { name: 'omp in its help-banner style', output: 'omp v18.15.0', want: 'omp' },
    { name: 'a name that merely starts with omp is not omp', output: 'ompx/1.0.0', want: 'pi' },
    { name: 'pi prints the bare version', output: '1.4.0', want: 'pi' },
    { name: 'older pi', output: '0.67.68', want: 'pi' },
    { name: 'empty output falls back to pi', output: '', want: 'pi' },
    { name: 'omp mentioned later is not omp', output: '1.4.0 (not omp/1)', want: 'pi' },
  ];
  test.each(cases)('$name', ({ output, want }) => {
    expect(flavorFromVersion(output)).toBe(want);
  });
});

describe('ompSessionsRoot', () => {
  const home = '/home/u';
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; want: string }> = [
    { name: 'defaults to ~/.omp/agent/sessions', env: {}, want: join(home, '.omp', 'agent', 'sessions') },
    {
      name: 'PI_CODING_AGENT_DIR replaces the agent dir',
      env: { PI_CODING_AGENT_DIR: '/data/omp-agent' },
      want: join('/data/omp-agent', 'sessions'),
    },
    {
      name: 'PI_CONFIG_DIR renames the root under home',
      env: { PI_CONFIG_DIR: '.omp-work' },
      want: join(home, '.omp-work', 'agent', 'sessions'),
    },
    {
      name: 'PI_CODING_AGENT_DIR wins over PI_CONFIG_DIR',
      env: { PI_CODING_AGENT_DIR: '/data/a', PI_CONFIG_DIR: '.omp-work' },
      want: join('/data/a', 'sessions'),
    },
  ];
  test.each(cases)('$name', ({ env, want }) => {
    expect(ompSessionsRoot(env, home)).toBe(want);
  });
});

describe('refute: ompSessionsRoot follows omp to profile and XDG locations', () => {
  const home = '/home/u';
  let xdg: string;
  beforeEach(() => {
    xdg = mkdtempSync(join(tmpdir(), 'xdg-data-'));
    // `omp config init-xdg` creates $XDG_DATA_HOME/omp; omp then writes sessions there.
    mkdirSync(join(xdg, 'omp'));
  });
  afterEach(() => rmSync(xdg, { recursive: true, force: true }));

  const cases: Array<{ name: string; env: (xdg: string) => NodeJS.ProcessEnv; want: (xdg: string) => string }> = [
    {
      name: 'OMP_PROFILE selects ~/.omp/profiles/<name>/agent/sessions',
      env: () => ({ OMP_PROFILE: 'work' }),
      want: () => join(home, '.omp', 'profiles', 'work', 'agent', 'sessions'),
    },
    {
      name: 'after init-xdg, sessions live under $XDG_DATA_HOME/omp/sessions',
      env: x => ({ XDG_DATA_HOME: x }),
      want: x => join(x, 'omp', 'sessions'),
    },
  ];
  test.each(cases)('$name', ({ env, want }) => {
    expect(ompSessionsRoot(env(xdg), home)).toBe(want(xdg));
  });
});

describe('ompSessionsRoot follows omp dirs.ts', () => {
  const home = '/home/u';
  const omp = (...p: string[]) => join(home, '.omp', ...p);
  const cases: Array<{
    name: string;
    env: NodeJS.ProcessEnv;
    existing?: string[];
    platform?: NodeJS.Platform;
    want: string;
  }> = [
    { name: 'PI_PROFILE when OMP_PROFILE is unset', env: { PI_PROFILE: 'p' }, want: omp('profiles', 'p', 'agent', 'sessions') },
    { name: 'OMP_PROFILE wins over PI_PROFILE', env: { OMP_PROFILE: 'a', PI_PROFILE: 'b' }, want: omp('profiles', 'a', 'agent', 'sessions') },
    { name: 'an empty OMP_PROFILE selects the default profile', env: { OMP_PROFILE: '', PI_PROFILE: 'b' }, want: omp('agent', 'sessions') },
    { name: '"default" is the default profile', env: { OMP_PROFILE: 'default' }, want: omp('agent', 'sessions') },
    { name: 'an invalid profile name falls back to the default', env: { OMP_PROFILE: 'Bad Name' }, want: omp('agent', 'sessions') },
    { name: 'a profile ignores PI_CODING_AGENT_DIR', env: { OMP_PROFILE: 'p', PI_CODING_AGENT_DIR: '/x' }, want: omp('profiles', 'p', 'agent', 'sessions') },
    {
      name: 'PI_CODING_AGENT_DIR that is only the overridden PI_PROFILE\'s dir is ignored',
      env: { OMP_PROFILE: '', PI_PROFILE: 'b', PI_CODING_AGENT_DIR: omp('profiles', 'b', 'agent') },
      want: omp('agent', 'sessions'),
    },
    { name: 'a relative PI_CODING_AGENT_DIR is resolved', env: { PI_CODING_AGENT_DIR: 'rel' }, want: join(process.cwd(), 'rel', 'sessions') },
    { name: 'XDG_DATA_HOME without $XDG_DATA_HOME/omp is not used', env: { XDG_DATA_HOME: '/xdg' }, want: omp('agent', 'sessions') },
    { name: 'XDG on Linux', env: { XDG_DATA_HOME: '/xdg' }, existing: ['/xdg/omp'], platform: 'linux', want: '/xdg/omp/sessions' },
    { name: 'no XDG on Windows', env: { XDG_DATA_HOME: '/xdg' }, existing: ['/xdg/omp'], platform: 'win32', want: omp('agent', 'sessions') },
    { name: 'an agent-dir override turns XDG off', env: { XDG_DATA_HOME: '/xdg', PI_CODING_AGENT_DIR: '/x' }, existing: ['/xdg/omp'], want: '/x/sessions' },
    {
      name: 'a profile uses XDG only once its own XDG dir exists',
      env: { OMP_PROFILE: 'p', XDG_DATA_HOME: '/xdg' }, existing: ['/xdg/omp'],
      want: omp('profiles', 'p', 'agent', 'sessions'),
    },
    {
      name: 'a profile with its own XDG dir',
      env: { OMP_PROFILE: 'p', XDG_DATA_HOME: '/xdg' }, existing: ['/xdg/omp', '/xdg/omp/profiles/p'],
      want: '/xdg/omp/profiles/p/sessions',
    },
    { name: 'PI_CONFIG_DIR with a profile', env: { PI_CONFIG_DIR: '.o', OMP_PROFILE: 'p' }, want: join(home, '.o', 'profiles', 'p', 'agent', 'sessions') },
  ];
  test.each(cases)('$name', ({ env, existing = [], platform = 'darwin', want }) => {
    expect(ompSessionsRoot(env, home, p => existing.includes(p), platform)).toBe(want);
  });
});

describe('ompAgentDir', () => {
  const home = '/home/u';
  const cases: Array<{ name: string; env: NodeJS.ProcessEnv; want: string }> = [
    { name: 'default', env: {}, want: join(home, '.omp', 'agent') },
    { name: 'a named profile', env: { OMP_PROFILE: 'work' }, want: join(home, '.omp', 'profiles', 'work', 'agent') },
    { name: 'PI_CODING_AGENT_DIR', env: { PI_CODING_AGENT_DIR: '/x' }, want: '/x' },
    { name: 'XDG does not move config', env: { XDG_DATA_HOME: '/xdg' }, want: join(home, '.omp', 'agent') },
    { name: 'HOME from the environment', env: { HOME: '/other' }, want: join('/other', '.omp', 'agent') },
  ];
  test.each(cases)('$name', ({ env, want }) => {
    expect(env.HOME ? ompAgentDir(env) : ompAgentDir(env, home)).toBe(want);
  });
});
