import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SessionUpdate } from './acp/types';
import { TranscriptStore, type Entry } from './transcript';
import { Replay } from './turns';

// Shapes copied from Qwen Code 0.26.5's session/load replay (CMDCTRL_ACP_TRACE), after a
// daemon restart cut a reply short: Qwen keeps no part of the cut reply, and sends the
// cut turn's prompt and the next one as back-to-back user chunks with no message id.
const user = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }) as SessionUpdate;
const agent = (text: string): SessionUpdate =>
  ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } }) as SessionUpdate;
const e = (uuid: string, role: 'USER' | 'AGENT', content: string): Entry => ({ uuid, role, content, timestamp: `t-${uuid}` });

function replayOf(updates: SessionUpdate[]): Entry[] {
  const replay = new Replay('s');
  updates.forEach((u) => replay.add(u));
  return replay.entries();
}

const show = (entries: Entry[]) => entries.map((m) => `${m.uuid} ${m.role} ${m.content}`);

// Changed for the user's rule – the agent is the system of record: the history read back is
// the agent's replay exactly (the cut reply only the daemon held is gone), each prompt its own
// message, never glued. Messages the app already showed keep their ids.
describe('refute r7: reload after a restart cut a reply short', () => {
  const cases: Array<{ name: string; recorded: Entry[]; replay: SessionUpdate[]; want: string[] }> = [
    {
      name: 'the next reply starting like the cut one shows once, not twice',
      recorded: [
        e('u1', 'USER', 'tell me a story'),
        e('a1', 'AGENT', 'Once upon a time'),
        e('u2', 'USER', 'start again'),
        e('a2', 'AGENT', 'Once upon a time there was a fox. The end.'),
      ],
      replay: [user('tell me a story'), user('start again'), agent('Once upon a time there was a fox. The end.')],
      want: [
        'u1 USER tell me a story',
        'u2 USER start again',
        'a2 AGENT Once upon a time there was a fox. The end.',
      ],
    },
    {
      name: 'a failed message after the restart is not added again, glued to the cut one',
      recorded: [
        e('u0', 'USER', 'hi'),
        e('a0', 'AGENT', 'hello'),
        e('u1', 'USER', 'tell me a story'),
        e('a1', 'AGENT', 'Once upon'),
        e('u2', 'USER', 'try again'),
      ],
      replay: [user('hi'), agent('hello'), user('tell me a story'), user('try again')],
      want: [
        'u0 USER hi',
        'a0 AGENT hello',
        'u1 USER tell me a story',
        'u2 USER try again',
      ],
    },
  ];

  it.each(cases)('$name', ({ recorded, replay, want }) => {
    const store = new TranscriptStore(fs.mkdtempSync(path.join(os.tmpdir(), 'acp-refute-r7-')));
    for (const entry of recorded) store.append('s', '/w', entry);
    store.applyReplay('s', '/w', replayOf(replay));
    expect(show(store.get('s')!.entries)).toEqual(want);
  });
});
