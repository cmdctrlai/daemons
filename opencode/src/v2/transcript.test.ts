import { fixture } from '../testing/fake-opencode-v2';
import { changedTurns, toEntries, turnResult, turnState, type V2Message } from './transcript';

/** A captured transcript, oldest first, cut after its `n`th message when given. */
const messages = (name: string, n?: number): V2Message[] => fixture<{ data: V2Message[] }>(`messages-${name}.json`).data.slice(0, n);
/** The captured pending-permission page is newest first. */
const pending = (): V2Message[] => fixture<{ data: V2Message[] }>('messages-pending-permission.json').data.reverse();

/** After every capture. */
const NOW = 1_793_500_000_000;

/** A command the user ran with `!`. */
const shellMsg = (id: string, status: string): V2Message => ({
  id, type: 'shell', status, time: { created: NOW }, command: 'echo hi', output: { output: 'hi\n' },
});

describe('a v2 transcript as the app shows it', () => {
  it('reads prompts, answers and an answered question, without tool steps or idle markers', () => {
    const entries = toEntries(messages('ses-a', 11));
    expect(entries.map((e) => [e.role, e.content])).toEqual([
      ['USER', 'Reply with exactly the words: pickle ready'],
      ['AGENT', 'pickle ready'],
      ['USER', 'Use your shell tool to run: ls -la. Then tell me how many entries it printed.'],
      ['AGENT', 'It printed **4 entries**: `.`, `..`, `.git`, and `README.md` (plus a `total 8` summary line).'],
      ['USER', 'Use your question tool to ask me which color I prefer, with the options Red and Blue. After I answer, reply with just the color I picked.'],
      ['AGENT', 'Which color do you prefer?'],
      ['USER', 'Blue'],
      ['AGENT', 'Blue'],
    ]);
    expect(entries[5]).toMatchObject({
      uuid: 'chatcmpl-tool-8627d46504c1eb18:0:q',
      question: {
        question: 'Which color do you prefer?',
        header: 'Color preference',
        options: [{ label: 'Red', description: 'Choose red' }, { label: 'Blue', description: 'Choose blue' }],
      },
    });
  });

  it('marks a turn the user stopped', () => {
    const entries = toEntries(messages('ses-b', 8));
    expect(entries.slice(-3).map((e) => [e.uuid, e.content])).toEqual([
      ['msg_194acd97f001Hqu5zQrUuA0998', 'Write a 1500 word essay about the history of pickles. Do not use any tools.'],
      ['msg_194acd984001WxTCbWtvxDLfKR', '# A Brine Through Time: The History of Pickles\n\nThe pickle is one'],
      ['msg_194acd984001WxTCbWtvxDLfKR:stopped', 'Stopped'],
    ]);
  });

  it('shows a compaction as the /compact the user sent, then its summary', () => {
    const entries = toEntries(messages('ses-c', 7));
    expect(entries.slice(-2).map((e) => [e.role, e.content.split('\n')[0]])).toEqual([
      ['USER', '/compact'],
      ['AGENT', '## Objective'],
    ]);
  });

  it('shows a command as typed when its expansion is known', () => {
    const command = messages('ses-b', 11).slice(-3)[0];
    expect(toEntries([command])[0].content).toBe('Reply with only the word PICKLE followed by: brine');
    expect(toEntries([command], (id) => (id === command.id ? '/pickle brine' : undefined))[0].content).toBe('/pickle brine');
  });

  it('shows a command the user ran with ! and what it printed', () => {
    const shell: V2Message = {
      id: 'msg_sh', type: 'shell', time: { created: NOW }, command: 'ls', output: { output: 'notes.md\n' },
    };
    expect(toEntries([shell]).map((e) => [e.role, e.content])).toEqual([['USER', '!ls'], ['AGENT', 'notes.md\n']]);
  });

  it('reads both answers of a two-question form, the multi-select joined', () => {
    const entries = toEntries(messages('ses-b'));
    expect(entries.slice(-6).map((e) => [e.role, e.content, e.question?.multi_select ?? false])).toEqual([
      ['USER', expect.stringContaining('TWO questions'), false],
      ['AGENT', 'Which fruit do you like?', false],
      ['USER', 'Banana actually', false],
      ['AGENT', 'Which toppings do you want?', true],
      ['USER', 'Salt, Lime', false],
      ['AGENT', expect.any(String), false],
    ]);
  });
});

describe('where a v2 turn stands', () => {
  const cases: Array<{ name: string; transcript: () => V2Message[]; want: Record<string, unknown> }> = [
    {
      name: 'an idle marker after a reply ends the turn',
      transcript: () => messages('ses-a', 3),
      want: { finished: true, stopped: false, running: false, finalId: 'msg_194aaeb49002p5rQhNIqy6c4RP', error: undefined, preview: 'pickle ready' },
    },
    {
      name: 'a turn held on a permission is still running',
      transcript: pending,
      want: { finished: false, running: true },
    },
    {
      name: 'an interrupted turn finished because the user stopped it',
      transcript: () => messages('ses-b', 8),
      want: { finished: true, stopped: true, error: undefined },
    },
    {
      name: 'a failed turn finished on its error',
      transcript: () => messages('ses-failed'),
      want: { finished: true, stopped: false, error: 'Model unavailable: opencode/no-such-model', preview: 'hi' },
    },
    {
      name: 'a ! command run after the turn ended is what the session last did',
      transcript: () => [...messages('ses-a', 3), shellMsg('msg_desk', 'exited')],
      want: { finished: true, running: false, finalId: 'msg_desk' },
    },
    {
      name: 'a ! command run between the agent\'s steps leaves the turn running',
      transcript: () => [...pending(), shellMsg('msg_mid', 'exited')],
      want: { finished: false, running: true },
    },
    {
      name: 'a ! command after a step that closed between tool calls leaves the turn running',
      transcript: () => [...messages('ses-a', 5), shellMsg('msg_mid', 'exited')],
      want: { finished: false, running: true },
    },
    {
      name: 'a ! command after a step still being aborted leaves the turn running',
      transcript: () => {
        const aborting = { ...messages('ses-b', 7)[6], time: { created: NOW } };
        return [...messages('ses-b', 6), aborting, shellMsg('msg_mid', 'exited')];
      },
      want: { finished: false, running: true },
    },
    {
      name: 'a turn that ends after a mid-turn ! command finishes on its idle marker',
      transcript: () => [...messages('ses-a', 2), shellMsg('msg_mid', 'exited'), messages('ses-a', 3)[2]],
      want: { finished: true, finalId: 'msg_194aaeb49002p5rQhNIqy6c4RP' },
    },
    {
      name: 'a ! command still running after the turn ended is running',
      transcript: () => [...messages('ses-a', 3), shellMsg('msg_desk', 'running')],
      want: { finished: false, running: true },
    },
    {
      name: 'a ! command still running is running',
      transcript: () => [{ id: 'msg_sh', type: 'shell', status: 'running', time: { created: NOW }, command: 'sleep 60' }],
      want: { finished: false, running: true },
    },
    {
      name: 'a prompt nobody answered for minutes is not running',
      transcript: () => messages('ses-failed', 1),
      want: { finished: false, running: false },
    },
  ];
  it.each(cases)('$name', ({ transcript, want }) => {
    expect(turnState(transcript(), NOW, NOW)).toMatchObject(want);
  });
});

describe('the result a v2 turn ended on', () => {
  const cases: Array<{ name: string; transcript: () => V2Message[]; want: { text: string; error?: string } }> = [
    { name: 'the final step\'s text after tool steps', transcript: () => messages('ses-a', 7), want: { text: 'It printed **4 entries**: `.`, `..`, `.git`, and `README.md` (plus a `total 8` summary line).' } },
    { name: 'the error a failed turn ended on', transcript: () => messages('ses-failed'), want: { text: '', error: 'Model unavailable: opencode/no-such-model' } },
    { name: 'what a stopped turn had written', transcript: () => messages('ses-b', 8), want: { text: '# A Brine Through Time: The History of Pickles\n\nThe pickle is one' } },
    { name: 'nothing for a compaction', transcript: () => messages('ses-c', 7), want: { text: '' } },
  ];
  it.each(cases)('$name', ({ transcript, want }) => {
    expect(turnResult(transcript())).toEqual(want);
  });
});

describe('which v2 turns changed files', () => {
  it('names each turn by its user message, newest first, skipping turns that changed nothing', () => {
    expect(changedTurns(messages('ses-b'))).toEqual([{
      id: 'msg_194aca598001zdtpGe2JO876Wt',
      prompt: 'Without using the shell, append a line gamma to notes.md. Then say done.',
      timestamp: new Date(messages('ses-b')[0].time.created).toISOString(),
    }]);
  });
});
