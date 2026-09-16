/**
 * AskUserQuestion carries its question and choices in the tool input rather
 * than in text blocks, so the reader lifts them out. Without this the message
 * is invisible and clients render a bare tool chip with nothing to tap.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readMessagesFromFile, ReadMessageEntry } from './message-reader';

/** Wrap an AskUserQuestion tool input in an assistant JSONL line. */
function questionLine(uuid: string, input: unknown): string {
  return JSON.stringify({
    uuid,
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input }] },
    timestamp: '2026-09-15T10:00:00.000Z',
  });
}

describe('AskUserQuestion messages', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'question-reader-test-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function read(input: unknown): ReadMessageEntry[] {
    fs.writeFileSync(tempFile, questionLine('q1', input) + '\n');
    return readMessagesFromFile(tempFile, 50).messages;
  }

  const cases: Array<{
    name: string;
    input: unknown;
    expect: (messages: ReadMessageEntry[]) => void;
  }> = [
    {
      name: 'surfaces question text, header and options',
      input: {
        questions: [
          {
            question: 'Tabs or spaces?',
            header: 'Indent',
            options: [
              { label: 'Tabs', description: 'Elastic' },
              { label: 'Spaces', description: 'Consistent' },
            ],
          },
        ],
      },
      expect: (messages) => {
        expect(messages).toHaveLength(1);
        expect(messages[0].role).toBe('AGENT');
        expect(messages[0].content).toBe('Tabs or spaces?');
        expect(messages[0].question).toEqual({
          question: 'Tabs or spaces?',
          header: 'Indent',
          options: [
            { label: 'Tabs', description: 'Elastic' },
            { label: 'Spaces', description: 'Consistent' },
          ],
        });
      },
    },
    {
      name: 'marks a multi-select question',
      input: {
        questions: [
          {
            question: 'Which platforms?',
            multiSelect: true,
            options: [{ label: 'iOS' }, { label: 'Android' }],
          },
        ],
      },
      expect: (messages) => {
        expect(messages[0].question?.multi_select).toBe(true);
        expect(messages[0].question?.options).toEqual([
          { label: 'iOS' },
          { label: 'Android' },
        ]);
      },
    },
    {
      name: 'takes only the first question',
      input: {
        questions: [
          { question: 'First?', options: [{ label: 'A' }] },
          { question: 'Second?', options: [{ label: 'B' }] },
        ],
      },
      expect: (messages) => {
        expect(messages).toHaveLength(1);
        expect(messages[0].content).toBe('First?');
      },
    },
    {
      name: 'drops blank and malformed options',
      input: {
        questions: [
          {
            question: 'Pick one',
            options: [{ label: '  ' }, { label: 'Real' }, { description: 'orphan' }],
          },
        ],
      },
      expect: (messages) => {
        expect(messages[0].question?.options).toEqual([{ label: 'Real' }]);
      },
    },
    {
      name: 'skips a question with no usable options',
      input: { questions: [{ question: 'Pick one', options: [] }] },
      expect: (messages) => expect(messages).toHaveLength(0),
    },
    {
      name: 'skips a question with no text',
      input: { questions: [{ question: '   ', options: [{ label: 'A' }] }] },
      expect: (messages) => expect(messages).toHaveLength(0),
    },
    {
      name: 'skips an empty questions array',
      input: { questions: [] },
      expect: (messages) => expect(messages).toHaveLength(0),
    },
    {
      name: 'skips a non-object input',
      input: 'not an object',
      expect: (messages) => expect(messages).toHaveLength(0),
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      testCase.expect(read(testCase.input));
    });
  }

  it('leaves ordinary assistant text alone', () => {
    fs.writeFileSync(
      tempFile,
      JSON.stringify({
        uuid: 'a1',
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Just talking.' }] },
        timestamp: '2026-09-15T10:00:00.000Z',
      }) + '\n'
    );
    const messages = readMessagesFromFile(tempFile, 50).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('Just talking.');
    expect(messages[0].question).toBeUndefined();
  });
});

/**
 * A tapped answer never becomes a user message of its own – the tool consumes
 * it. The result the tool writes back is the only record, so the reader turns
 * it into one; otherwise the question stays the newest entry and a reload
 * offers the same options again.
 */
describe('AskUserQuestion answers', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'answer-reader-test-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  /** Wrap a tool result in the user JSONL line the CLI writes. */
  function resultLine(content: unknown): string {
    return JSON.stringify({
      uuid: 'a1',
      type: 'user',
      message: { content: [{ type: 'tool_result', content, tool_use_id: 'toolu_1' }] },
      timestamp: '2026-09-15T10:00:01.000Z',
    });
  }

  function read(content: unknown): ReadMessageEntry[] {
    fs.writeFileSync(tempFile, resultLine(content) + '\n');
    return readMessagesFromFile(tempFile, 50).messages;
  }

  const cases: { name: string; content: unknown; want: string | null }[] = [
    {
      name: 'a single answer becomes the user message',
      content:
        'Your questions have been answered: "Dark or light theme?"="Light". You can now continue with these answers in mind.',
      want: 'Light',
    },
    {
      name: 'several answers are joined',
      content:
        'Your questions have been answered: "Theme?"="Light", "Editor?"="Vim". You can now continue with these answers in mind.',
      want: 'Light, Vim',
    },
    {
      name: 'free text the user typed instead of tapping',
      content:
        'The user answered: "Theme?"="whatever you think best". Read the answers carefully \u2014 they may request clarification, changes, or that you not proceed \u2014 and follow what they actually say.',
      want: 'whatever you think best',
    },
    {
      name: 'a quote inside an answer does not truncate it',
      content:
        'The user answered: "Theme?"="He said "hi" to me". Read the answers carefully \u2014 they may request clarification, changes, or that you not proceed \u2014 and follow what they actually say.',
      want: 'He said "hi" to me',
    },
    {
      name: 'a comma inside an answer does not split it',
      content:
        'The user answered: "Theme?"="Light, but warm", "Editor?"="Vim". Read the answers carefully \u2014 they may request clarification, changes, or that you not proceed \u2014 and follow what they actually say.',
      want: 'Light, but warm, Vim',
    },
    {
      name: 'a question left unanswered is reported without a value',
      content:
        'The user answered: "Theme?"="Light", "Editor?"=(no option selected). Read the answers carefully \u2014 they may request clarification, changes, or that you not proceed \u2014 and follow what they actually say.',
      want: 'Light',
    },
    {
      name: 'no answer at all leaves no message behind',
      content: 'The user did not answer the questions.',
      want: null,
    },
    {
      name: 'an interrupted call leaves no message behind',
      content: '[Request interrupted by user for tool use]',
      want: null,
    },
    {
      name: 'an ordinary tool result stays invisible',
      content: 'total 48\ndrwxr-xr-x  6 user  staff 192 Sep 15 10:00 .',
      want: null,
    },
    {
      name: 'a structured result is not mistaken for an answer',
      content: [{ type: 'text', text: 'Your questions have been answered: "Q"="A".' }],
      want: null,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const messages = read(c.content);
      if (c.want === null) {
        expect(messages).toHaveLength(0);
        return;
      }
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('USER');
      expect(messages[0].content).toBe(c.want);
    });
  }
});
