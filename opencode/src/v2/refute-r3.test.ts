// Refutation, round 3: `!cmd` and where the turn stands.
// Transcripts captured from opencode 2.2.5 with the model held on an endpoint that never answers.
import { ActivityReporter } from '../activity';
import { FakeOpenCodeV2, PASSWORD } from '../testing/fake-opencode-v2';
import { OpenCodeV2Adapter } from './adapter';
import { turnState, type V2Message } from './transcript';

/**
 * A turn cut off by opencode shutting down (v2 files no idle for `interrupted: shutdown`),
 * then, on a fresh server with nothing running (`/api/session/active` -> {}), `!echo after-restart`.
 */
const AFTER_SHUTDOWN = [
  { id: 'msg_19544abd6001A3t4sk8NwCUy5R', time: { created: 1793505668059 }, text: 'say hi', type: 'user' },
  {
    id: 'msg_19544aca2002SndB9b0y9AmsX7', metadata: { background: true }, time: { created: 1793505668258, completed: 1793505668261 },
    type: 'shell', shellID: 'sh_19544aca1001VJL0qsPmZThpaW', command: 'echo mid-turn', status: 'exited', exit: 0,
    output: { output: 'mid-turn\n', cursor: 9, size: 9, truncated: false },
  },
  {
    id: 'msg_19544abe0001ivHwGfSrmoG903', time: { created: 1793505668066, completed: 1793505669095 }, type: 'assistant',
    agent: 'build', model: { id: 'big-pickle', providerID: 'opencode' }, content: [],
    snapshot: { start: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', end: '4b825dc642cb6eb9a060e54bf8d69288fbee4904', files: [] },
    finish: 'error', error: { type: 'aborted', message: 'Step interrupted' },
  },
  {
    id: 'msg_19544cab60010OLinr97Yc1e2Z', metadata: { background: true }, time: { created: 1793505675958, completed: 1793505675960 },
    type: 'shell', shellID: 'sh_19544cab5001XbIHESsAPCOuzD', command: 'echo after-restart', status: 'exited', exit: 0,
    output: { output: 'after-restart\n', cursor: 14, size: 14, truncated: false },
  },
] as V2Message[];
const DESK_SHELL_ID = 'msg_19544cab60010OLinr97Yc1e2Z';
const SHUTDOWN_UPDATED = 1793505675961;

/** A turn held open on the model, and five `!` commands run while it waits. */
const shellAt = (i: number): V2Message => ({
  id: `msg_1954${i}`, type: 'shell', status: 'exited', command: `echo mid-${i}`, output: { output: `mid-${i}\n` },
  time: { created: 1793504663000 + i, completed: 1793504663001 + i },
});
const FIVE_MID_TURN: V2Message[] = [
  { id: 'msg_19540', time: { created: 1793504662966 }, text: 'say hi', type: 'user' },
  ...[1, 2, 3, 4, 5].map(shellAt),
];
const FIVE_SESSION = {
  id: 'ses_five', time: { created: 1793504662675, updated: 1793504663010, busy: 1793504662961 }, location: { directory: '/tmp/proj' },
};

describe('a desk ! command after a turn opencode shut down mid-way', () => {
  it('reads finished once it exits', () => {
    expect(turnState(AFTER_SHUTDOWN, SHUTDOWN_UPDATED, SHUTDOWN_UPDATED + 1000))
      .toMatchObject({ finished: true, running: false, finalId: DESK_SHELL_ID });
  });

  it('is announced to a phone watching the session', async () => {
    const fake = new FakeOpenCodeV2();
    const adapter = new OpenCodeV2Adapter(await fake.start(), PASSWORD);
    try {
      fake.sessions = [{ id: 'ses_shut', time: { created: 1, updated: SHUTDOWN_UPDATED, busy: 2 }, location: { directory: '/tmp/proj' } }];
      const pushes: boolean[] = [];
      const reporter = new ActivityReporter(adapter, { sendSessionActivity: (_s, _f, _m, _c, isCompletion) => pushes.push(isCompletion) });
      fake.transcripts.set('ses_shut', AFTER_SHUTDOWN.slice(0, 3));
      await reporter.watch('ses_shut');
      fake.transcripts.set('ses_shut', AFTER_SHUTDOWN);
      await reporter.poll('ses_shut');
      expect(pushes).toContain(true);
    } finally {
      await fake.stop();
    }
  });
});

describe('five ! commands run while the agent is still working', () => {
  it('leaves the turn running in the full transcript', () => {
    const updated = FIVE_SESSION.time.updated;
    expect(turnState(FIVE_MID_TURN, updated, updated + 1000)).toMatchObject({ finished: false, running: true });
  });
});
