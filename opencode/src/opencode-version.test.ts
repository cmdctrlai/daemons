import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { opencodeEnv } from './adapter/opencode';
import { OpenCodeAdapter } from './adapter/opencode';
import { serverFor } from './opencode-server';
import { checkOpencode, opencodeVersion, parseVersion, refuseTasks, unsupportedReason } from './opencode-version';
import { OpenCodeV2Adapter } from './v2/adapter';

const V3 = "opencode v3 isn't supported yet – CmdCtrl works with opencode 1.x and 2.x";

describe('which opencode the daemon can drive', () => {
  const cases: Array<{ name: string; output: string; version?: string; reason?: string; adapter: unknown }> = [
    { name: 'v1', output: '1.18.25\n', version: '1.18.25', adapter: OpenCodeAdapter },
    { name: 'v2, as 2.2.5 prints it', output: 'opencode v2.2.5\n', version: '2.2.5', adapter: OpenCodeV2Adapter },
    { name: 'a later major', output: '3.0.1\n', version: '3.0.1', reason: V3, adapter: OpenCodeAdapter },
    { name: 'no version printed', output: 'usage: opencode …\n', adapter: OpenCodeAdapter },
  ];
  it.each(cases)('$name', ({ output, version, reason, adapter }) => {
    expect(parseVersion(output)).toBe(version);
    expect(unsupportedReason(parseVersion(output))).toBe(reason);
    const { server, feed } = serverFor(parseVersion(output));
    expect(server).toBeInstanceOf(adapter);
    expect(feed?.path).toBe(adapter === OpenCodeV2Adapter ? '/api/event' : undefined);
  });
});

describe('the opencode binary the daemon would run', () => {
  let dir: string;
  const fake = (bin: string, version: string) => {
    mkdirSync(bin, { recursive: true });
    const path = join(bin, 'opencode');
    writeFileSync(path, `#!/bin/sh\necho ${version}\n`);
    chmodSync(path, 0o755);
  };

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'oc-version-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is the first opencode on PATH', async () => {
    fake(join(dir, 'bin'), '2.2.5');
    const env = opencodeEnv({ HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:/usr/bin:/bin` });
    expect(await opencodeVersion(env)).toBe('2.2.5');
  });

  it('is the one opencode\'s installer put in ~/.opencode/bin, ahead of PATH', async () => {
    fake(join(dir, 'home', '.opencode', 'bin'), '2.2.5');
    fake(join(dir, 'bin'), '1.18.25');
    const env = opencodeEnv({ HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:/usr/bin:/bin` });
    expect(await opencodeVersion(env)).toBe('2.2.5');
  });

  it('is reported to whoever started the daemon when it is newer than 2.x', async () => {
    fake(join(dir, 'bin'), '3.0.0');
    const lines: string[] = [];
    const env = opencodeEnv({ HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:/usr/bin:/bin` });
    expect(await checkOpencode((line) => lines.push(line), env)).toEqual({ version: '3.0.0', reason: V3 });
    expect(lines).toEqual([
      `${V3}. Found opencode 3.0.0.`,
      'The app shows the same when you start a session. Restart cmdctrl-opencode once opencode 1.x or 2.x is installed.',
    ]);
  });

  it.each(['1.18.25', '2.2.5'])('goes unmentioned when it is %s', async (version) => {
    fake(join(dir, 'bin'), version);
    const lines: string[] = [];
    const env = opencodeEnv({ HOME: join(dir, 'home'), PATH: `${join(dir, 'bin')}:/usr/bin:/bin` });
    expect(await checkOpencode((line) => lines.push(line), env)).toEqual({ version, reason: undefined });
    expect(lines).toEqual([]);
  });

  it('is unknown when there is none', async () => {
    const env = opencodeEnv({ HOME: join(dir, 'home'), PATH: join(dir, 'empty') });
    expect(await opencodeVersion(env)).toBeUndefined();
  });
});

describe('with an opencode the daemon cannot drive', () => {
  it('ends every task the user starts or replies to with the reason', async () => {
    let start: ((task: any) => unknown) | undefined;
    let resume: ((task: any) => unknown) | undefined;
    const client = {
      onTaskStart(handler: (task: any) => unknown) { start = handler; return this; },
      onTaskResume(handler: (task: any) => unknown) { resume = handler; return this; },
    };
    refuseTasks(client as never, V3);

    const errors: string[] = [];
    await start?.({ error: (m: string) => errors.push(m) });
    await resume?.({ error: (m: string) => errors.push(m) });
    expect(errors).toEqual([V3, V3]);
  });
});
