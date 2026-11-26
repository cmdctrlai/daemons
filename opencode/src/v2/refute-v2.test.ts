// Refutation tests for the v2 adapter.
// The live block runs against a real opencode 2.x: OC2_HOME=<dir whose .opencode/bin/opencode is v2>
// with XDG_DATA_HOME/XDG_CONFIG_HOME/XDG_STATE_HOME/XDG_CACHE_HOME pointed at scratch dirs.
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OpenCodeV2Adapter } from './adapter';
import { turnState, type V2Message } from './transcript';

/** Captured from opencode 2.2.5: a session whose only message is a `!echo hi-shell` that has exited. */
const EXITED_SHELL: V2Message = {
  id: 'msg_194f913a0002gbYd5XXJHFApo2',
  metadata: { background: true },
  time: { created: 1793500713888, completed: 1793500713890 },
  type: 'shell',
  shellID: 'sh_194f9139f001xrQNEkuxeYC1t6',
  command: 'echo hi-shell',
  status: 'exited',
  exit: 0,
  output: { output: 'hi-shell\n', cursor: 9, size: 9, truncated: false },
} as V2Message;

describe('a desk session whose last action was a ! command', () => {
  it('is not listed as running once the command has exited', () => {
    const updated = EXITED_SHELL.time.completed!;
    // One minute later the session list still reports it busy (is_active), for up to ten minutes.
    expect(turnState([EXITED_SHELL], updated, updated + 60_000).running).toBe(false);
  });
});

const home = process.env.OC2_HOME;
const live = home ? describe : describe.skip;

live('the server password, against a real opencode 2.x', () => {
  const password = 'refute-v2-server-password-0123456789';
  let adapter: OpenCodeV2Adapter;
  let realHome: string | undefined;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'refute-v2-'));
    realHome = process.env.HOME;
    process.env.HOME = home;
    adapter = new OpenCodeV2Adapter('', password);
    await adapter.startServer();
  }, 40_000);

  afterAll(() => {
    adapter?.stopServer();
    process.env.HOME = realHome;
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not reach the processes the server runs, or the transcript the phone reads', async () => {
    const sid = await adapter.createSession(dir);
    // The server's password is the one it generated – a chosen one could only reach it
    // through the environment its children inherit – so authenticate as the adapter does.
    const auth = adapter.eventFeed.headers!().Authorization;
    const serverPassword = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().replace(/^opencode:/, '');
    expect(serverPassword.length).toBeGreaterThan(16);
    const res = await fetch(`${adapter.url}/api/session/${sid}/shell`, {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'printenv OPENCODE_PASSWORD; echo end' }),
    });
    expect(res.status).toBeLessThan(300);
    let text = '';
    for (let i = 0; i < 50 && !text.includes('end'); i++) {
      await new Promise((r) => setTimeout(r, 100));
      text = (await adapter.getMessages(sid, 50)).messages.map((m) => m.content).join('\n');
    }
    expect(text).toContain('end');
    expect(text).not.toContain(serverPassword);
    expect(text).not.toContain(password);
  }, 20_000);
});
