/**
 * A slash command the CLI runs locally under the SDK (/status) is recorded only as an
 * enqueue plus a bare `system` local_command entry. History shows it once, as the user's
 * message, on every page. Live stays silent: a USER_MESSAGE after the task completes would
 * flip the session back to working with no turn to end it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMessagesFromFile } from './message-reader';
import { SessionEvent, SessionWatcher } from './session-watcher';

const T = (s: number) => `2026-01-01T00:00:${String(s).padStart(2, '0')}.000Z`;

const lines = [
  { uuid: 'u1', type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'start' }, timestamp: T(1) },
  { uuid: 'a1', type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: T(2) },
  // A draft pulled back to the editor: never shown.
  { type: 'queue-operation', operation: 'enqueue', timestamp: T(3), content: 'pulled back' },
  { type: 'queue-operation', operation: 'popAll', timestamp: T(4), content: 'pulled back' },
  // The SDK-sent local command.
  { type: 'queue-operation', operation: 'enqueue', timestamp: T(5), content: '/status' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: T(5) },
  { uuid: 'lc1', type: 'system', subtype: 'local_command', content: '/status', isMeta: false, timestamp: T(6) },
  { uuid: 'lc1-out', type: 'system', subtype: 'local_command', content: '<local-command-stdout>/status isn\'t available in this environment.</local-command-stdout>', isMeta: false, timestamp: T(6) },
  // The terminal's wrapped form of a local command, and a harness-flagged one: not shown.
  { uuid: 'lc2', type: 'system', subtype: 'local_command', content: '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>', timestamp: T(7) },
  { uuid: 'lc3', type: 'system', subtype: 'local_command', content: '/compact', isMeta: true, timestamp: T(7) },
  { uuid: 'i1', type: 'system', subtype: 'informational', content: '/not a command', timestamp: T(7) },
  { uuid: 'u2', type: 'user', promptSource: 'sdk', message: { role: 'user', content: 'next' }, timestamp: T(8) },
].map((l) => JSON.stringify(l));

const expected = ['u1|start', 'a1|ok', 'lc1|/status', 'u2|next'];

describe('local slash command recorded only as a system entry', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-command-'));
    file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const shown = (limit: number, before?: string, after?: string) =>
    readMessagesFromFile(file, limit, before, after).messages.map((m) => `${m.uuid}|${m.content}`);

  it.each([
    ['latest page', () => shown(10), expected],
    ['latest page of two', () => shown(2), expected.slice(2)],
    ['before the next message', () => shown(10, 'u2'), expected.slice(0, 3)],
    ['before the command', () => shown(10, 'lc1'), expected.slice(0, 2)],
    ['after the agent reply', () => shown(10, undefined, 'a1'), expected.slice(2)],
    ['after the command', () => shown(10, undefined, 'lc1'), expected.slice(3)],
  ])('history: %s', (_name, read, want) => {
    expect(read()).toEqual(want);
  });

  it('history paged one at a time matches the whole', () => {
    let all: string[] = [];
    let before: string | undefined;
    for (;;) {
      const page = readMessagesFromFile(file, 1, before);
      all = page.messages.map((m) => `${m.uuid}|${m.content}`).concat(all);
      if (!page.hasMore || !page.oldestUuid) break;
      before = page.oldestUuid;
    }
    expect(all).toEqual(expected);
  });

  it('live does not announce it', () => {
    fs.writeFileSync(file, '');
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e), () => {});
    const w = watcher as unknown as { watchedSessions: Map<string, unknown>; checkSession(s: unknown): void };
    try {
      watcher.watchSession('s', file);
      const session = w.watchedSessions.get('s');
      for (const line of lines) {
        fs.appendFileSync(file, line + '\n');
        w.checkSession(session);
      }
    } finally {
      watcher.unwatchAll();
    }
    const live = events
      .filter((e) => e.type === 'USER_MESSAGE' || e.type === 'AGENT_RESPONSE')
      .map((e) => `${e.uuid}|${e.content}`);
    expect(live).toEqual(expected.filter((m) => !m.startsWith('lc1|')));
    expect(events.find((e) => e.uuid === 'lc1')).toBeUndefined();
  });
});
