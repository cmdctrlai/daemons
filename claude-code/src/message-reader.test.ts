/**
 * Tests for readMessagesFromFile pagination, focused on cursor handling.
 *
 * Regression coverage for the stale-message replay bug: when an incremental
 * `after` cursor is no longer in the file (compacted/rewritten away), the reader
 * must NOT fall back to returning the file tail – doing so made live clients
 * append already-seen messages to the bottom of the view under their original
 * timestamps.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readMessagesFromFile } from './message-reader';

/** Build a JSONL user-message line the reader will parse into a MessageEntry. */
function userLine(uuid: string, content: string, timestamp: string): string {
  return JSON.stringify({
    uuid,
    type: 'user',
    message: { content },
    timestamp,
  });
}

describe('readMessagesFromFile', () => {
  let tempDir: string;
  let tempFile: string;

  /** Write the given uuids as sequential user messages and return the path. */
  function writeSession(uuids: string[]): string {
    const lines = uuids.map((u, i) =>
      userLine(u, `message ${u}`, `2026-07-04T20:0${i % 10}:00.000Z`)
    );
    fs.writeFileSync(tempFile, lines.join('\n') + '\n');
    return tempFile;
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'message-reader-test-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('cursor pagination', () => {
    const cases: Array<{
      name: string;
      file: string[];
      limit: number;
      beforeUuid?: string;
      afterUuid?: string;
      expectUuids: string[];
      expectHasMore: boolean;
    }> = [
      {
        name: 'no cursor returns the last `limit` messages in order',
        file: ['a', 'b', 'c', 'd'],
        limit: 2,
        expectUuids: ['c', 'd'],
        expectHasMore: true,
      },
      {
        name: 'no cursor with fewer messages than limit returns all',
        file: ['a', 'b'],
        limit: 10,
        expectUuids: ['a', 'b'],
        expectHasMore: false,
      },
      {
        name: 'afterUuid found returns messages after the cursor',
        file: ['a', 'b', 'c', 'd'],
        limit: 10,
        afterUuid: 'b',
        expectUuids: ['c', 'd'],
        expectHasMore: false,
      },
      {
        name: 'afterUuid found at end of file returns empty (client is up to date)',
        file: ['a', 'b', 'c'],
        limit: 10,
        afterUuid: 'c',
        expectUuids: [],
        expectHasMore: false,
      },
      {
        name: 'afterUuid found respects limit and flags has_more',
        file: ['a', 'b', 'c', 'd', 'e'],
        limit: 2,
        afterUuid: 'a',
        expectUuids: ['b', 'c'],
        expectHasMore: true,
      },
      {
        // The bug: cursor compacted away overnight; the tail is last night's
        // messages. The reader must return empty, NOT the tail.
        name: 'afterUuid stale (compacted away) returns empty, not the file tail',
        file: ['old-1', 'old-2', 'old-3'],
        limit: 10,
        afterUuid: 'cursor-that-no-longer-exists',
        expectUuids: [],
        expectHasMore: false,
      },
      {
        name: 'beforeUuid found returns messages before the cursor',
        file: ['a', 'b', 'c', 'd'],
        limit: 10,
        beforeUuid: 'c',
        expectUuids: ['a', 'b'],
        expectHasMore: false,
      },
      {
        name: 'beforeUuid stale returns empty',
        file: ['a', 'b', 'c'],
        limit: 10,
        beforeUuid: 'gone',
        expectUuids: [],
        expectHasMore: false,
      },
    ];

    it.each(cases)('$name', ({ file, limit, beforeUuid, afterUuid, expectUuids, expectHasMore }) => {
      const filePath = writeSession(file);
      const result = readMessagesFromFile(filePath, limit, beforeUuid, afterUuid);

      expect(result.messages.map((m) => m.uuid)).toEqual(expectUuids);
      expect(result.hasMore).toBe(expectHasMore);
    });
  });

  it('does not resurface old-timestamped messages via a stale after cursor', () => {
    // Simulate the observed scenario: this morning's client last saw `morning-2`,
    // then an overnight-style compaction rewrote the file so that uuid is gone and
    // only older entries remain. An incremental fetch must not hand those back.
    const filePath = writeSession(['evening-1', 'evening-2', 'evening-3']);
    const result = readMessagesFromFile(filePath, 30, undefined, 'morning-2');

    expect(result.messages).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});
