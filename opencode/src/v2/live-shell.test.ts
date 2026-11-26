// A `!` command on a real opencode 2.x, with a turn held open and without one.
// Runs only with OC2_HOME=<dir whose .opencode/bin/opencode is v2>. It makes its own
// data and config dirs, and holds the turn on a model endpoint that never answers –
// the model stays opencode/big-pickle, so no free-tier request is spent.
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { createServer, type Server, type ServerResponse } from 'http';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenCodeV2Adapter } from './adapter';

const home = process.env.OC2_HOME;
const live = home ? describe : describe.skip;
const XDG = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'] as const;

async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, what: string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${what} never happened`);
}

live('a ! command on a real opencode 2.x', () => {
  let root: string;
  let project: string;
  let model: Server;
  const held: ServerResponse[] = [];
  let modelCalls = 0;
  const saved: Record<string, string | undefined> = {};
  let adapter: OpenCodeV2Adapter;

  beforeAll(async () => {
    model = createServer((_req, res) => { modelCalls++; held.push(res); });
    await new Promise<void>((resolve) => model.listen(0, '127.0.0.1', resolve));
    const port = (model.address() as AddressInfo).port;

    root = mkdtempSync(join(tmpdir(), 'oc2-live-shell-'));
    for (const name of [...XDG, 'HOME']) saved[name] = process.env[name];
    for (const name of XDG) {
      process.env[name] = join(root, name);
      mkdirSync(process.env[name]!, { recursive: true });
    }
    mkdirSync(join(root, 'XDG_CONFIG_HOME', 'opencode'));
    writeFileSync(join(root, 'XDG_CONFIG_HOME', 'opencode', 'opencode.json'), JSON.stringify({
      model: 'opencode/big-pickle',
      update: 'disable',
      providers: { opencode: { settings: { baseURL: `http://127.0.0.1:${port}/v1`, timeout: false, headerTimeout: false } } },
    }));
    project = join(root, 'project');
    mkdirSync(project);
    execFileSync('git', ['init', '-q'], { cwd: project });

    process.env.HOME = home;
    adapter = new OpenCodeV2Adapter();
    await adapter.startServer();
  }, 40_000);

  afterAll(async () => {
    adapter?.stopServer();
    for (const res of held) res.destroy();
    await new Promise((resolve) => model.close(resolve));
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Run `command` as the user's `!` command and wait for it to exit. */
  async function shell(sid: string, command: string, output: string): Promise<void> {
    const res = await fetch(`${adapter.url}/api/session/${sid}/shell`, {
      method: 'POST',
      headers: { ...adapter.eventFeed.headers!(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ command }),
    });
    expect(res.status).toBeLessThan(300);
    await until(() => adapter.getMessages(sid, 50), (p) => p.messages.some((m) => m.content === output), `${command} exiting`);
  }

  const listed = async (sid: string) => (await adapter.listSessions(new Set())).find((s) => s.session_id === sid);

  it('ends a session with a desk ! command after opencode shut down mid-turn', async () => {
    const sid = await adapter.createSession(project);
    const calls = modelCalls;
    await adapter.send(sid, 'say hi', undefined, (err) => { throw err; });
    await until(async () => modelCalls, (n) => n > calls, 'the turn reaching the model');

    // v2 files no idle for a turn a shutdown interrupts; a fresh server reads the cut-off step.
    adapter.stopServer();
    adapter = new OpenCodeV2Adapter();
    await adapter.startServer();
    await until(() => adapter.getMessages(sid, 50), (p) => p.messages.some((m) => m.content === 'Stopped'), 'the cut-off step');

    await shell(sid, 'echo after-restart', 'after-restart\n');
    expect((await adapter.activity(sid)).state).toMatchObject({ finished: true, running: false });
    expect((await listed(sid))?.is_active).toBe(false);
  }, 60_000);

  it('leaves a working turn running, and ends a session once no turn is open', async () => {
    const sid = await adapter.createSession(project);
    await adapter.send(sid, 'say hi', undefined, (err) => { throw err; });
    await until(async () => modelCalls, (n) => n > 0, 'the turn reaching the model');

    await shell(sid, 'echo mid-turn', 'mid-turn\n');
    expect((await adapter.activity(sid)).state).toMatchObject({ finished: false, running: true });
    expect((await listed(sid))?.is_active).toBe(true);

    await adapter.abort(sid);
    await adapter.awaitTurnEnd(sid, 10_000);
    await shell(sid, 'echo at-the-desk', 'at-the-desk\n');
    const { state } = await adapter.activity(sid);
    expect(state).toMatchObject({ finished: true, stopped: false, running: false });
    expect((await adapter.getMessages(sid, 50)).messages.at(-2)).toMatchObject({ uuid: state.finalId, content: '!echo at-the-desk' });
    expect((await listed(sid))?.is_active).toBe(false);
  }, 60_000);
});
