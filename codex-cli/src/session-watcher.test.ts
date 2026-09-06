/**
 * Covers the watcher's use of the shared parser: appended turns in either
 * rollout format must surface as events, with UUIDs matching the scheme
 * session-discovery.ts uses when it reports the same messages.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

import { CodexSessionEvent, CodexSessionWatcher } from './session-watcher';
import { resetRolloutWarnings } from './session-parser';

const SESSION_ID = '01a07276-a69c-7282-8e89-6bab77f2da3a';

const META =
  `{"timestamp":"2026-09-05T16:46:13.683Z","type":"session_meta","payload":{"id":"${SESSION_ID}","timestamp":"2026-09-05T16:46:13.683Z","cwd":"/Users/dev/src/scratch","cli_version":"0.153.4"}}`;

const NEW_TURN = [
  '{"timestamp":"2026-09-05T16:50:06.216Z","type":"event_msg","payload":{"type":"task_started","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","started_at":1788627006}}',
  '{"timestamp":"2026-09-05T16:50:06.518Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","id":"01a0727a-3436-7c92-b344-bff233fa56d7","content":[{"type":"text","text":"what time is i?","text_elements":[]}]}}}',
  '{"timestamp":"2026-09-05T16:50:09.239Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","id":"rs_1","summary_text":[],"raw_content":[]}}}',
  '{"timestamp":"2026-09-05T16:50:13.536Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","id":"msg_1","content":[{"type":"Text","text":"10:50 AM MDT on September 5, 2026."}],"phase":"final_answer"}}}',
  '{"timestamp":"2026-09-05T16:50:16.535Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","last_agent_message":"10:50 AM MDT on September 5, 2026."}}',
];

const OLD_TURN = [
  '{"timestamp":"2026-08-30T22:48:22.102Z","type":"event_msg","payload":{"type":"user_message","message":"what time is i?","images":[],"text_elements":[]}}',
  '{"timestamp":"2026-08-30T22:49:02.471Z","type":"event_msg","payload":{"type":"agent_message","message":"10:50 AM MDT on September 5, 2026.","phase":"final_answer","memory_citation":null}}',
  '{"timestamp":"2026-08-30T22:49:02.794Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"01a054dc-0a0c-7252-a0a9-dd2f3dfd7119","last_agent_message":"10:50 AM MDT on September 5, 2026."}}',
];

/** The UUID scheme session-discovery.ts and session-watcher.ts both apply. */
function expectedUuid(messageId: string): string {
  const hash = crypto.createHash('sha256').update(`${SESSION_ID}:${messageId}`).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    '8' + hash.slice(17, 20),
    hash.slice(20, 32),
  ].join('-');
}

describe('CodexSessionWatcher', () => {
  let tmpDir: string;
  let watcher: CodexSessionWatcher | null;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-watcher-'));
    watcher = null;
    resetRolloutWarnings();
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    watcher?.unwatchAll();
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; turn: string[] }> = [
    { name: 'new format (>= 0.151)', turn: NEW_TURN },
    { name: 'old format (<= 0.148)', turn: OLD_TURN },
  ];

  it.each(cases)('emits appended turns – $name', async ({ turn }) => {
    const filePath = path.join(tmpDir, `rollout-${SESSION_ID}.jsonl`);
    fs.writeFileSync(filePath, META + '\n');

    const events: CodexSessionEvent[] = [];
    const twoEvents = new Promise<void>(resolve => {
      watcher = new CodexSessionWatcher(event => {
        events.push(event);
        if (events.length === 2) resolve();
      });
    });

    watcher!.watchSession(SESSION_ID, filePath);
    expect(watcher!.watchCount).toBe(1);

    fs.appendFileSync(filePath, turn.join('\n') + '\n');
    await twoEvents;

    expect(events).toEqual([
      expect.objectContaining({
        type: 'USER_MESSAGE',
        sessionId: SESSION_ID,
        uuid: expectedUuid('user-0'),
        content: 'what time is i?',
      }),
      expect.objectContaining({
        type: 'AGENT_RESPONSE',
        sessionId: SESSION_ID,
        uuid: expectedUuid('agent-1'),
        content: '10:50 AM MDT on September 5, 2026.',
      }),
    ]);
  });

  it('does not re-emit messages that were already in the file', async () => {
    const filePath = path.join(tmpDir, `rollout-${SESSION_ID}.jsonl`);
    fs.writeFileSync(filePath, [META, ...NEW_TURN].join('\n') + '\n');

    const events: CodexSessionEvent[] = [];
    watcher = new CodexSessionWatcher(event => events.push(event));
    watcher.watchSession(SESSION_ID, filePath);

    await new Promise(resolve => setTimeout(resolve, 1200));
    expect(events).toEqual([]);
  });
});
