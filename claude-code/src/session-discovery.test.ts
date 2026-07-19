/**
 * Tests for discoverCliUserTitles – scans ~/.claude/sessions/<pid>.json for
 * the live value of Claude Code's /rename command.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { discoverCliUserTitles } from './session-discovery';

describe('discoverCliUserTitles', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-rename-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  type Case = {
    name: string;
    files: Record<string, string>;
    expected: Array<[string, string]>;
  };

  const cases: Case[] = [
    {
      name: 'reads name from real-world per-PID JSON',
      files: {
        '68420.json': JSON.stringify({
          pid: 68420,
          sessionId: '2f2ef9da-d73c-456f-a819-18e27d3ada41',
          name: 'Reprice',
          updatedAt: 1778347637194,
        }),
      },
      expected: [['2f2ef9da-d73c-456f-a819-18e27d3ada41', 'Reprice']],
    },
    {
      name: 'reads multi-word names',
      files: {
        '7164.json': JSON.stringify({
          pid: 7164,
          sessionId: '01b63b18-9562-4040-834a-7bc198d935d2',
          name: 'claude code leak discovery',
        }),
      },
      expected: [['01b63b18-9562-4040-834a-7bc198d935d2', 'claude code leak discovery']],
    },
    {
      name: 'aggregates multiple files into one map',
      files: {
        '111.json': JSON.stringify({ pid: 111, sessionId: 'aaa', name: 'one' }),
        '222.json': JSON.stringify({ pid: 222, sessionId: 'bbb', name: 'two' }),
      },
      expected: [
        ['aaa', 'one'],
        ['bbb', 'two'],
      ],
    },
    {
      name: 'skips files missing sessionId',
      files: {
        'orphan.json': JSON.stringify({ pid: 1, name: 'no-id' }),
      },
      expected: [],
    },
    {
      name: 'skips files missing name',
      files: {
        'noname.json': JSON.stringify({ pid: 1, sessionId: 'abc' }),
      },
      expected: [],
    },
    {
      name: 'skips empty / whitespace-only names',
      files: {
        'empty.json': JSON.stringify({ pid: 1, sessionId: 'abc', name: '   ' }),
      },
      expected: [],
    },
    {
      name: 'ignores non-.json files',
      files: {
        'something.txt': 'not json',
        '999.json': JSON.stringify({ pid: 999, sessionId: 'xyz', name: 'kept' }),
      },
      expected: [['xyz', 'kept']],
    },
    {
      name: 'tolerates malformed JSON without throwing',
      files: {
        'broken.json': '{not valid json',
        'good.json': JSON.stringify({ pid: 1, sessionId: 'good-id', name: 'good-name' }),
      },
      expected: [['good-id', 'good-name']],
    },
    {
      name: 'returns empty map when directory is empty',
      files: {},
      expected: [],
    },
  ];

  for (const tc of cases) {
    test(tc.name, () => {
      for (const [filename, content] of Object.entries(tc.files)) {
        fs.writeFileSync(path.join(tempDir, filename), content);
      }
      const result = discoverCliUserTitles(tempDir);
      const actual = [...result.entries()].sort();
      const expected = [...tc.expected].sort();
      expect(actual).toEqual(expected);
    });
  }

  test('returns empty map when directory does not exist', () => {
    const result = discoverCliUserTitles(path.join(tempDir, 'does-not-exist'));
    expect(result.size).toBe(0);
  });
});
