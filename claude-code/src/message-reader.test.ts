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

/** Build a JSONL line the reader will skip (not a user/assistant message). */
function fillerLine(index: number): string {
  return JSON.stringify({
    uuid: `filler-${index}`,
    type: 'file-history-snapshot',
    timestamp: '2026-07-04T20:00:00.000Z',
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

  describe('first-page has_more on sparse transcripts', () => {
    /**
     * Write `messageCount` user messages, each padded with `fillerPerMessage`
     * non-message entries, mimicking a tool-heavy transcript where only a small
     * fraction of JSONL lines are displayable.
     */
    function writeSparseSession(messageCount: number, fillerPerMessage: number): string {
      const lines: string[] = [];
      let filler = 0;
      for (let i = 0; i < messageCount; i++) {
        lines.push(userLine(`m${i}`, `message ${i}`, `2026-07-04T20:00:0${i % 10}.000Z`));
        for (let f = 0; f < fillerPerMessage; f++) lines.push(fillerLine(filler++));
      }
      fs.writeFileSync(tempFile, lines.join('\n') + '\n');
      return tempFile;
    }

    const cases: Array<{
      name: string;
      messageCount: number;
      fillerPerMessage: number;
      limit: number;
      expectHasMore: boolean;
      expectCount: number;
      expectOldestUuid: string;
    }> = [
      {
        // The regression: density far below the reader's initial guess meant the
        // fixed scan window yielded fewer than `limit` messages, and has_more was
        // derived from that count – so a long conversation claimed to be complete.
        name: 'sparse transcript far longer than one page reports more',
        messageCount: 200,
        fillerPerMessage: 40,
        limit: 30,
        expectHasMore: true,
        expectCount: 30,
        expectOldestUuid: 'm170',
      },
      {
        name: 'very sparse transcript still reports more',
        messageCount: 100,
        fillerPerMessage: 200,
        limit: 10,
        expectHasMore: true,
        expectCount: 10,
        expectOldestUuid: 'm90',
      },
      {
        name: 'dense transcript longer than one page reports more',
        messageCount: 100,
        fillerPerMessage: 0,
        limit: 30,
        expectHasMore: true,
        expectCount: 30,
        expectOldestUuid: 'm70',
      },
      {
        name: 'sparse transcript shorter than one page reports no more',
        messageCount: 5,
        fillerPerMessage: 60,
        limit: 30,
        expectHasMore: false,
        expectCount: 5,
        expectOldestUuid: 'm0',
      },
      {
        name: 'transcript of exactly one page reports no more',
        messageCount: 30,
        fillerPerMessage: 10,
        limit: 30,
        expectHasMore: false,
        expectCount: 30,
        expectOldestUuid: 'm0',
      },
    ];

    it.each(cases)('$name', ({ messageCount, fillerPerMessage, limit, expectHasMore, expectCount, expectOldestUuid }) => {
      const filePath = writeSparseSession(messageCount, fillerPerMessage);
      const result = readMessagesFromFile(filePath, limit);

      expect(result.messages).toHaveLength(expectCount);
      expect(result.hasMore).toBe(expectHasMore);
      expect(result.oldestUuid).toBe(expectOldestUuid);
      // The page must be the contiguous tail of the conversation.
      expect(result.newestUuid).toBe(`m${messageCount - 1}`);
      expect(result.messages.map((m) => m.uuid)).toEqual(
        Array.from({ length: expectCount }, (_, i) => `m${messageCount - expectCount + i}`)
      );
    });

    it('does not splice head-of-file messages into a page that stopped short', () => {
      // The backward reader recovers garbled lines at the start of the file. When
      // the scan never reaches the start, those lines belong to a later page –
      // mixing them in produced a page with a hole in the middle and an
      // oldest_uuid pointing near the true beginning of the conversation.
      const filePath = writeSparseSession(300, 30);
      const result = readMessagesFromFile(filePath, 20);

      expect(result.hasMore).toBe(true);
      expect(result.messages.map((m) => m.uuid)).not.toContain('m0');
      expect(result.oldestUuid).toBe('m280');
    });

    it('walks the whole conversation by paging back to the start', () => {
      const filePath = writeSparseSession(120, 25);
      const seen: string[] = [];
      let cursor: string | undefined;
      let hasMore = true;
      let pages = 0;

      while (hasMore && pages < 50) {
        const page = readMessagesFromFile(filePath, 20, cursor);
        seen.unshift(...page.messages.map((m) => m.uuid));
        hasMore = page.hasMore;
        cursor = page.oldestUuid;
        pages++;
      }

      expect(hasMore).toBe(false);
      expect(seen).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
    });
  });
  describe('byte-level scanning', () => {
    /**
     * Write messages whose payloads are large enough that lines straddle the
     * reader's 64KB read chunks, so every chunk boundary falls inside a line.
     */
    function writeBulkySession(count: number, payloadBytes: number): string {
      const lines = Array.from({ length: count }, (_, i) =>
        userLine(`m${i}`, `${i}:` + 'x'.repeat(payloadBytes), `2026-07-04T20:00:0${i % 10}.000Z`)
      );
      fs.writeFileSync(tempFile, lines.join('\n') + '\n');
      return tempFile;
    }

    it('keeps every line intact across chunk boundaries', () => {
      // Backward reading assembles each line from the chunk that holds its end
      // and the chunk that holds its start. Carrying the wrong fragment garbled
      // the first line of every chunk and dropped one line per boundary.
      const count = 60;
      const filePath = writeBulkySession(count, 4096);
      expect(fs.statSync(filePath).size).toBeGreaterThan(3 * 64 * 1024);

      const result = readMessagesFromFile(filePath, count);

      expect(result.hasMore).toBe(false);
      expect(result.messages.map((m) => m.uuid)).toEqual(
        Array.from({ length: count }, (_, i) => `m${i}`)
      );
      result.messages.forEach((m, i) => {
        expect(m.content).toBe(`${i}:` + 'x'.repeat(4096));
      });
    });

    it('decodes multibyte characters that straddle a chunk boundary', () => {
      // Chunks are sliced at newlines, never mid-character, so a payload made
      // entirely of 4-byte code points must survive a boundary landing inside one.
      const emoji = '🙂';
      const lines = Array.from({ length: 12 }, (_, i) =>
        userLine(`m${i}`, emoji.repeat(3000), `2026-07-04T20:00:0${i}.000Z`)
      );
      fs.writeFileSync(tempFile, lines.join('\n') + '\n');

      const result = readMessagesFromFile(tempFile, 12);

      expect(result.messages).toHaveLength(12);
      for (const message of result.messages) {
        expect(message.content).toBe(emoji.repeat(3000));
        expect(message.content).not.toContain('\uFFFD');
      }
    });

    it('recovers the uuid of an oversized line from its tail', () => {
      // An assistant turn carrying an image runs past the size cap. uuid and
      // timestamp sit at the end of the JSON, which backward reading sees first,
      // so both survive even though the middle of the line is dropped.
      const huge = JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'here is the screenshot' },
            { type: 'image', source: { data: 'A'.repeat(300 * 1024) } },
          ],
        },
        uuid: 'huge',
        timestamp: '2026-07-04T20:00:01.000Z',
      });
      const lines = [
        userLine('small-before', 'before', '2026-07-04T20:00:00.000Z'),
        huge,
        userLine('small-after', 'after', '2026-07-04T20:00:02.000Z'),
      ];
      fs.writeFileSync(tempFile, lines.join('\n') + '\n');

      const result = readMessagesFromFile(tempFile, 10);

      expect(result.messages.map((m) => m.uuid)).toEqual(['small-before', 'huge', 'small-after']);
      const oversized = result.messages[1];
      expect(oversized.timestamp).toBe('2026-07-04T20:00:01.000Z');
      expect(oversized.content).toBe('here is the screenshot');
    });

    it('gives an entry without a uuid the same id from every page', () => {
      // Generated ids are derived from the line's byte offset rather than its
      // position in a scan, so a cursor page and the first page agree and a
      // cursor minted on one path still resolves on the other.
      const lines: string[] = [];
      for (let i = 0; i < 40; i++) {
        lines.push(
          JSON.stringify({
            type: 'user',
            message: { content: `anonymous ${i}` },
            timestamp: `2026-07-04T20:00:${String(i).padStart(2, '0')}.000Z`,
          })
        );
      }
      fs.writeFileSync(tempFile, lines.join('\n') + '\n');

      const firstPage = readMessagesFromFile(tempFile, 10);
      expect(firstPage.hasMore).toBe(true);

      const olderPage = readMessagesFromFile(tempFile, 10, firstPage.oldestUuid);
      expect(olderPage.messages).toHaveLength(10);
      expect(olderPage.messages.map((m) => m.content)).toEqual(
        Array.from({ length: 10 }, (_, i) => `anonymous ${20 + i}`)
      );

      // The same entries reached from the far side of the file keep their ids.
      const forwardPage = readMessagesFromFile(tempFile, 10, undefined, olderPage.oldestUuid);
      expect(forwardPage.messages.slice(0, 9).map((m) => m.uuid)).toEqual(
        olderPage.messages.slice(1).map((m) => m.uuid)
      );
    });

    it('returns nothing when a before cursor is no longer in the file', () => {
      const filePath = writeSession(['a', 'b', 'c']);
      const result = readMessagesFromFile(filePath, 10, 'compacted-away');

      expect(result.messages).toEqual([]);
      expect(result.hasMore).toBe(false);
    });
  });
  describe('queue de-duplication agrees across pages', () => {
    /** A CmdCtrl-sent message as it appears before Claude Code processes it. */
    function queueLine(content: string, timestamp: string): string {
      return JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content, timestamp });
    }

    function assistantLine(uuid: string, text: string, timestamp: string): string {
      return JSON.stringify({
        uuid,
        type: 'assistant',
        message: { content: [{ type: 'text', text }] },
        timestamp,
      });
    }

    it('keeps a pending queued message that repeats older text', () => {
      // The real twin is always later in the file than its queue entry, so only
      // an entry the backward scan has already passed may suppress one. Matching
      // against the whole page instead hid a message still waiting to be sent.
      fs.writeFileSync(
        tempFile,
        [
          queueLine('continue', '2026-01-01T00:00:01.000Z'),
          userLine('u1', 'continue', '2026-01-01T00:00:02.000Z'),
          assistantLine('a1', 'ok', '2026-01-01T00:00:03.000Z'),
          queueLine('continue', '2026-01-01T00:00:04.000Z'),
        ].join('\n') + '\n'
      );

      const pending = 'queue-2026-01-01T00:00:04.000Z';
      expect(readMessagesFromFile(tempFile, 10).messages.map((m) => m.uuid)).toEqual([
        'u1',
        'a1',
        pending,
      ]);
      expect(readMessagesFromFile(tempFile, 10, undefined, 'a1').messages.map((m) => m.uuid)).toEqual([
        pending,
      ]);
      expect(readMessagesFromFile(tempFile, 10, pending).messages.map((m) => m.uuid)).toEqual([
        'u1',
        'a1',
      ]);
    });

    it('drops a processed queue entry across megabytes of unrelated text', () => {
      // The dedupe window holds digests rather than content, so a session full
      // of pasted logs does not push the real twin out before its queue entry.
      const lines = [assistantLine('a0', 'start', '2026-01-01T00:00:00.000Z')];
      lines.push(queueLine('deploy it', '2026-01-01T00:00:01.000Z'));
      for (let i = 0; i < 30; i++) {
        lines.push(userLine(`p${i}`, `paste ${i} ` + 'z'.repeat(80 * 1024), `2026-01-01T00:01:${String(i).padStart(2, '0')}.000Z`));
      }
      lines.push(userLine('u2', 'deploy it', '2026-01-01T00:02:00.000Z'));
      lines.push(assistantLine('a1', 'done', '2026-01-01T00:02:01.000Z'));
      fs.writeFileSync(tempFile, lines.join('\n') + '\n');

      const queueUuid = 'queue-2026-01-01T00:00:01.000Z';
      for (const result of [
        readMessagesFromFile(tempFile, 100),
        readMessagesFromFile(tempFile, 100, undefined, 'a0'),
        readMessagesFromFile(tempFile, 100, 'a1'),
      ]) {
        expect(result.messages.map((m) => m.uuid)).not.toContain(queueUuid);
        expect(result.messages.filter((m) => m.content === 'deploy it')).toHaveLength(1);
      }
    });

    it('matches a queued message against its trimmed twin', () => {
      fs.writeFileSync(
        tempFile,
        [
          queueLine('ship it\n', '2026-01-01T00:00:01.000Z'),
          userLine('u1', 'ship it', '2026-01-01T00:00:02.000Z'),
        ].join('\n') + '\n'
      );

      expect(readMessagesFromFile(tempFile, 10).messages.map((m) => m.uuid)).toEqual(['u1']);
    });
  });
});
