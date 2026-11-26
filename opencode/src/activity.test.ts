import { ActivityReporter } from './activity';
import { OpenCodeAdapter } from './adapter/opencode';
import type { OpenCodeMessage } from './adapter/transcript';
import { FakeOpenCode, msg } from './testing/fake-opencode';

const SID = 'ses_desk';

let fake: FakeOpenCode;
let sent: Array<{ last: string; count: number; completion: boolean }>;
let reporter: ActivityReporter;

beforeEach(async () => {
  fake = new FakeOpenCode();
  const adapter = new OpenCodeAdapter(await fake.start());
  sent = [];
  reporter = new ActivityReporter(adapter, {
    sendSessionActivity: (_id, _path, last, count, completion) => sent.push({ last, count, completion }),
  });
});

afterEach(() => fake.stop());

const prompt = msg('u1', 'user', 'fix the build');
const step = (open = false) => msg('a1', 'assistant', 'Looking at the build.', {
  finish: 'tool-calls', time: { created: 1, ...(open ? {} : { completed: 2 }) },
});
const answer = (open = false) => msg('a2', 'assistant', 'Fixed: the import was wrong.', {
  finish: open ? undefined : 'stop', time: { created: 3, ...(open ? {} : { completed: 4 }) },
});

describe('a turn started at the desk', () => {
  it('announces completion once, when the turn ends rather than at each step', async () => {
    fake.transcripts.set(SID, [msg('u0', 'user', 'earlier'), msg('a0', 'assistant', 'earlier answer')]);
    await reporter.watch(SID);

    const frames: OpenCodeMessage[][] = [
      [prompt],
      [prompt, step(true)],
      [prompt, step()],
      [prompt, step(), answer(true)],
      [prompt, step(), answer()],
      [prompt, step(), answer()],
    ];
    for (const frame of frames) {
      fake.transcripts.set(SID, [msg('u0', 'user', 'earlier'), msg('a0', 'assistant', 'earlier answer'), ...frame]);
      await reporter.poll(SID);
    }

    expect(sent.map((s) => s.completion)).toEqual([false, false, false, true]);
    expect(sent[sent.length - 1]).toEqual({ last: 'Fixed: the import was wrong.', count: 5, completion: true });
  });

  it('does not announce what was already finished when watching began', async () => {
    fake.transcripts.set(SID, [prompt, step(), answer()]);
    await reporter.watch(SID);
    await reporter.poll(SID);
    expect(sent).toEqual([]);
  });

  it('announces a turn that ends on an error', async () => {
    fake.transcripts.set(SID, [prompt]);
    await reporter.watch(SID);
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { finish: undefined, error: { name: 'APIError' } })]);
    await reporter.poll(SID);
    expect(sent.map((s) => s.completion)).toEqual([true]);
  });

  it('announces a failed turn with its error rather than the prompt', async () => {
    fake.transcripts.set(SID, [prompt]);
    await reporter.watch(SID);
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', '', { finish: undefined, error: { name: 'APIError', data: { message: 'quota exhausted' } } })]);
    await reporter.poll(SID);
    expect(sent).toEqual([{ last: 'Error: quota exhausted', count: 1, completion: true }]);
  });
});

describe('a turn this daemon ran', () => {
  it('is announced when it finishes, even with nobody watching the session', async () => {
    fake.transcripts.set(SID, [prompt, step(), answer()]);
    await reporter.finished(SID);
    await reporter.finished(SID);
    expect(sent).toEqual([{ last: 'Fixed: the import was wrong.', count: 3, completion: true }]);
  });

  it('is announced once when the watch poll saw the end first', async () => {
    fake.transcripts.set(SID, [prompt]);
    await reporter.watch(SID);
    fake.transcripts.set(SID, [prompt, step(), answer()]);
    await reporter.poll(SID);
    await reporter.finished(SID);
    expect(sent.filter((s) => s.completion)).toHaveLength(1);
  });
});

describe('a stopped turn', () => {
  it('is never announced as a completion', async () => {
    fake.transcripts.set(SID, [prompt]);
    await reporter.watch(SID);
    fake.transcripts.set(SID, [prompt, msg('a1', 'assistant', 'Partial', { finish: undefined, error: { name: 'MessageAbortedError' } })]);
    await reporter.poll(SID);
    await reporter.finished(SID);
    expect(sent.filter((s) => s.completion)).toEqual([]);
  });
});
