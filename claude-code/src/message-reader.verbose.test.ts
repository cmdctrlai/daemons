/**
 * The newest message carries the tool activity of the turn that produced it.
 *
 * Tool calls are dropped from every message the reader returns, so a client
 * re-entering a session used to see a final answer with no sign of the work
 * behind it. These cover which message gets the lines, which lines it gets,
 * and – as much as anything else here – that no other message gets any.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readMessagesFromFile, ReadMessageEntry } from './message-reader';

const TS = '2026-09-15T10:00:00.000Z';

function text(uuid: string, type: 'user' | 'assistant', body: string): string {
  return JSON.stringify({
    uuid,
    type,
    message: { content: [{ type: 'text', text: body }] },
    timestamp: TS,
  });
}

/** An assistant entry that only calls tools – never a message on its own. */
function tools(uuid: string, calls: Array<{ name: string; input?: unknown }>): string {
  return JSON.stringify({
    uuid,
    type: 'assistant',
    message: {
      content: calls.map((c) => ({ type: 'tool_use', name: c.name, input: c.input ?? {} })),
    },
    timestamp: TS,
  });
}

/** The tool_result wrapper the CLI writes back as a user-role entry. */
function toolResult(uuid: string, body: string): string {
  return JSON.stringify({
    uuid,
    type: 'user',
    toolUseResult: { stdout: body },
    message: { content: [{ type: 'tool_result', content: body }] },
    timestamp: TS,
  });
}

/** A subagent's own entry – real work, but not this session's to show. */
function sidechainTools(uuid: string, name: string, input: unknown): string {
  return JSON.stringify({
    uuid,
    type: 'assistant',
    isSidechain: true,
    message: { content: [{ type: 'tool_use', name, input }] },
    timestamp: TS,
  });
}

describe('verbose on the newest message', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbose-reader-test-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function read(lines: string[], limit = 50): ReadMessageEntry[] {
    fs.writeFileSync(tempFile, lines.join('\n') + '\n');
    return readMessagesFromFile(tempFile, limit).messages;
  }

  const cases: Array<{
    name: string;
    lines: string[];
    expect: (messages: ReadMessageEntry[]) => void;
  }> = [
    {
      name: 'the final answer carries its turn, oldest call first',
      lines: [
        text('u1', 'user', 'what broke?'),
        tools('a1', [{ name: 'Grep', input: { pattern: 'panic' } }]),
        toolResult('r1', 'server.go:42'),
        tools('a2', [{ name: 'Read', input: { file_path: '/srv/server.go' } }]),
        toolResult('r2', 'func main()'),
        text('a3', 'assistant', 'A nil map write on line 42.'),
      ],
      expect: (messages) => {
        expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a3']);
        expect(messages[1].verbose).toEqual([
          '🔎 Grepping: panic',
          '📖 Reading /srv/server.go',
        ]);
      },
    },
    {
      name: 'several calls in one entry keep their order',
      lines: [
        text('u1', 'user', 'go'),
        tools('a1', [
          { name: 'Bash', input: { command: 'go build ./...' } },
          { name: 'Bash', input: { command: 'go test ./...' } },
        ]),
        toolResult('r1', 'ok'),
        text('a2', 'assistant', 'Green.'),
      ],
      expect: (messages) => {
        expect(messages[1].verbose).toEqual([
          '⚡ Running: go build ./...',
          '⚡ Running: go test ./...',
        ]);
      },
    },
    {
      name: 'only the newest message carries verbose',
      lines: [
        text('u1', 'user', 'first'),
        tools('a1', [{ name: 'Read', input: { file_path: '/a' } }]),
        toolResult('r1', 'a'),
        text('a2', 'assistant', 'read it'),
        text('u2', 'user', 'second'),
        tools('a3', [{ name: 'Read', input: { file_path: '/b' } }]),
        toolResult('r2', 'b'),
        text('a4', 'assistant', 'read that too'),
      ],
      expect: (messages) => {
        expect(messages.map((m) => m.uuid)).toEqual(['a2', 'u2', 'a4']);
        expect(messages.map((m) => m.verbose)).toEqual([
          undefined,
          undefined,
          ['📖 Reading /b'],
        ]);
      },
    },
    {
      name: 'a turn with no tool calls leaves the field off',
      lines: [text('u1', 'user', 'hi'), text('a1', 'assistant', 'hello')],
      expect: (messages) => {
        expect(messages[1].verbose).toBeUndefined();
      },
    },
    {
      name: 'a user message last gets nothing, even interrupting a turn',
      lines: [
        text('u1', 'user', 'go'),
        tools('a1', [{ name: 'Bash', input: { command: 'sleep 600' } }]),
        text('u2', 'user', 'stop'),
      ],
      expect: (messages) => {
        expect(messages.map((m) => m.uuid)).toEqual(['u1', 'u2']);
        expect(messages.every((m) => m.verbose === undefined)).toBe(true);
      },
    },
    {
      name: 'a long turn keeps the newest 50 lines',
      lines: [
        text('u1', 'user', 'sweep'),
        ...Array.from({ length: 70 }, (_, i) =>
          tools(`a${i}`, [{ name: 'Read', input: { file_path: `/f${i}` } }])
        ),
        text('done', 'assistant', 'swept'),
      ],
      expect: (messages) => {
        const verbose = messages[messages.length - 1].verbose!;
        expect(verbose).toHaveLength(50);
        expect(verbose[0]).toBe('📖 Reading /f20');
        expect(verbose[49]).toBe('📖 Reading /f69');
      },
    },
    {
      name: 'an oversized argument is clipped',
      lines: [
        text('u1', 'user', 'go'),
        tools('a1', [{ name: 'Read', input: { file_path: '/' + 'x'.repeat(500) } }]),
        text('a2', 'assistant', 'done'),
      ],
      expect: (messages) => {
        const line = messages[1].verbose![0];
        expect(line).toHaveLength(201);
        expect(line.endsWith('…')).toBe(true);
      },
    },
    {
      name: 'the verbose turn survives the page being trimmed to the limit',
      lines: [
        ...Array.from({ length: 6 }, (_, i) => text(`old${i}`, 'user', `q${i}`)),
        tools('a1', [{ name: 'TodoWrite' }]),
        text('last', 'assistant', 'answer'),
      ],
      expect: (messages) => {
        expect(messages).toHaveLength(3);
        expect(messages[messages.length - 1].verbose).toEqual(['📝 Updating todos']);
      },
    },
    {
      name: 'an entry that both speaks and calls a tool contributes its call',
      lines: [
        text('u1', 'user', 'check it'),
        JSON.stringify({
          uuid: 'a1',
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: 'Let me look.' },
              { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            ],
          },
          timestamp: TS,
        }),
        toolResult('r1', 'x.go'),
        tools('a2', [{ name: 'Read', input: { file_path: '/x' } }]),
        text('a3', 'assistant', 'done'),
      ],
      expect: (messages) => {
        expect(messages.map((m) => m.uuid)).toEqual(['u1', 'a1', 'a3']);
        expect(messages[1].verbose).toBeUndefined();
        expect(messages[2].verbose).toEqual(['⚡ Running: ls', '📖 Reading /x']);
      },
    },
    {
      name: 'a narrated turn keeps every call, not just those after the last remark',
      lines: [
        text('u1', 'user', 'fix the build'),
        tools('a1', [{ name: 'Grep', input: { pattern: 'undefined' } }]),
        toolResult('r1', 'main.go:7'),
        text('a2', 'assistant', 'Found it. Let me patch and rebuild.'),
        tools('a3', [{ name: 'Edit', input: { file_path: '/main.go' } }]),
        toolResult('r2', 'ok'),
        tools('a4', [{ name: 'Bash', input: { command: 'go build ./...' } }]),
        toolResult('r3', ''),
        text('a5', 'assistant', 'Builds clean.'),
      ],
      expect: (messages) => {
        expect(messages[messages.length - 1].verbose).toEqual([
          '\u{1F50E} Grepping: undefined',
          '\u{1F527} Editing /main.go',
          '\u26A1 Running: go build ./...',
        ]);
      },
    },
    {
      name: 'a subagent\u2019s tool calls stay out of the turn',
      lines: [
        text('u1', 'user', 'investigate'),
        tools('a1', [{ name: 'Task', input: { description: 'search the repo' } }]),
        sidechainTools('s1', 'Read', { file_path: '/secret' }),
        toolResult('r1', 'report'),
        text('a2', 'assistant', 'here is what it found'),
      ],
      expect: (messages) => {
        expect(messages[messages.length - 1].verbose).toEqual([
          '\u{1F4CB} Spawning task: search the repo',
        ]);
      },
    },
    {
      name: 'one entry with more calls than the cap is still bounded',
      lines: [
        text('u1', 'user', 'go'),
        tools(
          'a1',
          Array.from({ length: 120 }, (_, i) => ({
            name: 'Read',
            input: { file_path: `/f${i}` },
          }))
        ),
        text('a2', 'assistant', 'done'),
      ],
      expect: (messages) => {
        expect(messages[messages.length - 1].verbose).toHaveLength(50);
      },
    },
    {
      name: 'an entry too large to parse does not end the turn early',
      lines: [
        text('u1', 'user', 'go'),
        tools('a1', [{ name: 'Read', input: { file_path: '/a' } }]),
        tools('a2', [{ name: 'Write', input: { file_path: '/big', content: 'x'.repeat(200_000) } }]),
        tools('a3', [{ name: 'Bash', input: { command: 'ls' } }]),
        text('a4', 'assistant', 'done'),
      ],
      expect: (messages) => {
        const verbose = messages[messages.length - 1].verbose;
        expect(verbose).toContain('\u{1F4D6} Reading /a');
        expect(verbose).toContain('\u26A1 Running: ls');
      },
    },
    {
      name: 'a bare null line is skipped rather than thrown on',
      lines: [
        text('u1', 'user', 'go'),
        'null',
        tools('a1', [{ name: 'Bash', input: { command: 'ls' } }]),
        text('a2', 'assistant', 'done'),
      ],
      expect: (messages) => {
        expect(messages[messages.length - 1].verbose).toEqual(['\u26A1 Running: ls']);
      },
    },
    {
      name: 'clipping never leaves half an emoji',
      lines: [
        text('u1', 'user', 'go'),
        tools('a1', [{ name: 'Bash', input: { command: '\u{1F525}'.repeat(400) } }]),
        text('a2', 'assistant', 'done'),
      ],
      expect: (messages) => {
        const line = messages[messages.length - 1].verbose![0];
        for (let i = 0; i < line.length; i++) {
          const code = line.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = line.charCodeAt(i + 1);
            expect(next >= 0xdc00 && next <= 0xdfff).toBe(true);
            i++;
          } else {
            expect(code >= 0xdc00 && code <= 0xdfff).toBe(false);
          }
        }
      },
    },
  ];

  test.each(cases)('$name', ({ lines, expect: assert }) => {
    assert(read(lines, 3));
  });
});

describe('verbose is not attached to cursored pages', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbose-cursor-test-'));
    tempFile = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(
      tempFile,
      [
        text('u1', 'user', 'first'),
        tools('a1', [{ name: 'Read', input: { file_path: '/a' } }]),
        text('a2', 'assistant', 'one'),
        text('u2', 'user', 'second'),
        tools('a3', [{ name: 'Read', input: { file_path: '/b' } }]),
        text('a4', 'assistant', 'two'),
      ].join('\n') + '\n'
    );
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const cases: Array<{ name: string; before?: string; after?: string }> = [
    { name: 'loading older leaves history untouched', before: 'u2' },
    { name: 'the incremental fetch adds nothing', after: 'u1' },
  ];

  test.each(cases)('$name', ({ before, after }) => {
    const { messages } = readMessagesFromFile(tempFile, 50, before, after);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.verbose === undefined)).toBe(true);
  });
});
