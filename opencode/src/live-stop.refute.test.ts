// Against a real opencode server: OC_LIVE_URL=http://127.0.0.1:<port> OC_LIVE_SID=<session> npx jest src/live-stop.refute.test.ts
import { OpenCodeAdapter } from './adapter/opencode';
import { OpenCodeEvents } from './events';
import { TurnManager, type TurnHandle } from './turns';

const url = process.env.OC_LIVE_URL;
const SID = process.env.OC_LIVE_SID ?? '';
const live = url ? describe : describe.skip;

function recorder(taskId: string): { calls: unknown[][]; handle: TurnHandle } {
  const calls: unknown[][] = [];
  return {
    calls,
    handle: {
      taskId,
      progress: (action, target) => calls.push(['progress', action, target]),
      complete: (result) => calls.push(['complete', result]),
      waitForUser: (prompt) => calls.push(['wait', prompt]),
      error: (message) => calls.push(['error', message]),
    },
  };
}

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
  return cond();
};

live('real opencode', () => {
  let adapter: OpenCodeAdapter;
  let turns: TurnManager;
  let events: OpenCodeEvents;

  beforeAll(async () => {
    adapter = new OpenCodeAdapter(url);
    turns = new TurnManager(adapter, { tool: () => {}, finished: () => {} });
    adapter.busy = (directory) => turns.busyIn(directory);
    await new Promise<void>((resolve) => {
      events = new OpenCodeEvents(url!, (e) => turns.handleEvent(e), () => resolve());
      events.start();
    });
  });
  afterAll(() => events.stop());

  it('lists the file the agent wrote, with its patch', async () => {
    const turnsWithFiles = await adapter.diff(SID);
    const files = turnsWithFiles.flatMap((t) => t.files);
    expect(files.find((f) => f.file === 'notes.md')).toMatchObject({ status: 'added', additions: 1, deletions: 0 });
    expect(files.find((f) => f.file === 'notes.md')?.patch).toContain('+checked');
  });

  it('a correction sent right after Stop is not ended by the stop', async () => {
    const taskId = `dev-x:opencode:${SID}`;
    const first = recorder(taskId);
    await turns.send(SID, first.handle, 'Run the shell command: sleep 30, then reply done.');
    expect(await until(() => first.calls.some((c) => c[0] === 'progress'), 60_000)).toBe(true);

    const t0 = Date.now();
    const stopping = turns.stop(SID, taskId);
    const second = recorder(taskId);
    await turns.send(SID, second.handle, 'Reply with exactly: redirected');
    await stopping;
    const stopMs = Date.now() - t0;

    // Give the correction time to answer, then see what its task was told.
    await until(() => second.calls.some((c) => c[0] === 'complete' && c[1] !== ''), 60_000);
    const transcript = (await adapter.getMessages(SID, 10)).messages.map((m) => `${m.role}: ${m.content}`.slice(0, 60));
    console.log({ stopMs, first: first.calls, second: second.calls, busy: turns.isBusy(SID), transcript });
    expect(second.calls.filter((c) => c[0] === 'complete')).toEqual([['complete', expect.stringContaining('redirected')]]);
  }, 150_000);
});
