// Refutation, round 2: a `!cmd` the user runs while the agent is still working.
// v2 accepts a shell mid-turn (POST /shell -> 204) and files it after the turn's user
// message; the session itself still reports busy (time.busy set, no time.idle).
import { ActivityReporter } from '../activity';
import { FakeOpenCodeV2, PASSWORD } from '../testing/fake-opencode-v2';
import { OpenCodeV2Adapter } from './adapter';
import { turnState, type V2Message } from './transcript';

/** Captured from opencode 2.2.5: a big-pickle turn still waiting on the model, then `!echo mid-turn`. */
const MID_TURN: V2Message[] = [
  { id: 'msg_195355538001jQbdAY4UPS4rI3', time: { created: 1793504662966 }, text: 'say hi', type: 'user' },
  {
    id: 'msg_195356182002IV0W2d6cdu8Qns',
    metadata: { background: true },
    time: { created: 1793504665986, completed: 1793504665989 },
    type: 'shell',
    shellID: 'sh_19535617f001vXQVN7wHiAnjfZ',
    command: 'echo mid-turn',
    status: 'exited',
    exit: 0,
    output: { output: 'mid-turn\n', cursor: 9, size: 9, truncated: false },
  } as V2Message,
];
/** The session as v2 served it at that moment: busy since the prompt, never idle. */
const MID_TURN_SESSION = {
  id: 'ses_e6acaab85ffeOg9b9PrAnLEeU1',
  time: { created: 1793504662675, updated: 1793504665990, busy: 1793504662961 },
  location: { directory: '/tmp/proj' },
};
const SID = MID_TURN_SESSION.id;
const UPDATED = MID_TURN_SESSION.time.updated;

describe('a ! command run while the agent is still working', () => {
  it('leaves the turn running', () => {
    expect(turnState(MID_TURN, UPDATED, UPDATED + 1000)).toMatchObject({ finished: false, running: true });
  });

  describe('through the daemon', () => {
    let fake: FakeOpenCodeV2;
    let adapter: OpenCodeV2Adapter;
    let realNow: () => number;

    beforeEach(async () => {
      fake = new FakeOpenCodeV2();
      adapter = new OpenCodeV2Adapter(await fake.start(), PASSWORD);
      fake.sessions = [MID_TURN_SESSION];
      realNow = Date.now;
      Date.now = () => UPDATED + 1000;
    });

    afterEach(async () => {
      Date.now = realNow;
      await fake.stop();
    });

    it('lists the session as busy', async () => {
      fake.transcripts.set(SID, MID_TURN);
      const [listed] = await adapter.listSessions(new Set());
      expect(listed.is_active).toBe(true);
    });

    it('sends no completion push to a phone watching the session', async () => {
      const pushes: boolean[] = [];
      const reporter = new ActivityReporter(adapter, { sendSessionActivity: (_s, _f, _m, _c, isCompletion) => pushes.push(isCompletion) });
      fake.transcripts.set(SID, MID_TURN.slice(0, 1));
      await reporter.watch(SID);
      fake.transcripts.set(SID, MID_TURN);
      await reporter.poll(SID);
      expect(pushes).not.toContain(true);
    });
  });
});
