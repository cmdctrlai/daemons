/**
 * The filter rules themselves, plus proof that the live path (SessionWatcher)
 * and the history path (readMessagesFromFile) apply them identically.
 *
 * The case that motivated the shared module: a message relayed in from another
 * Claude session arrives as a `user` entry whose text starts "Another Claude
 * session sent a message:". It defeats every prefix and leading-character rule,
 * and only `isMeta` identifies it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  hasHarnessFlagInRawLine,
  hasNonHumanOriginInRawLine,
  isHarnessEntry,
  isHarnessText,
  isHumanEntry,
  isHumanRawLine,
  unwrapPastedContent,
} from './transcript-filter';
import { readMessagesFromFile } from './message-reader';
import { SessionWatcher, SessionEvent } from './session-watcher';

/** The real shape of the relayed-message entry, from a production transcript. */
const AGENT_MESSAGE_TEXT =
  'Another Claude session sent a message:\n' +
  '<agent-message from="a2712015c2fa09f27">\n' +
  '[Subagent hand-back] The text below is the final report of a subagent.\n' +
  '</agent-message>';

describe('isHarnessEntry', () => {
  const cases: Array<{ name: string; entry: Record<string, unknown>; want: boolean }> = [
    {
      name: 'relayed message from another Claude session (isMeta)',
      entry: { type: 'user', isMeta: true, isSidechain: false },
      want: true,
    },
    { name: 'subagent turn (isSidechain)', entry: { type: 'user', isSidechain: true }, want: true },
    { name: 'compaction summary', entry: { type: 'user', isCompactSummary: true }, want: true },
    {
      name: 'transcript-only entry',
      entry: { type: 'user', isVisibleInTranscriptOnly: true },
      want: true,
    },
    { name: 'assistant turn carrying isMeta', entry: { type: 'assistant', isMeta: true }, want: true },
    {
      name: 'ordinary user message with the flags present and false',
      entry: { type: 'user', isMeta: false, isSidechain: false },
      want: false,
    },
    { name: 'ordinary user message with no flags at all', entry: { type: 'user' }, want: false },
    {
      name: 'string "true" is not the boolean and must not filter',
      entry: { type: 'user', isMeta: 'true' },
      want: false,
    },
    {
      name: 'task notification naming its own origin',
      entry: { type: 'user', origin: { kind: 'task-notification' }, promptSource: 'system' },
      want: true,
    },
    { name: 'human origin', entry: { type: 'user', origin: { kind: 'human' }, promptSource: 'typed' }, want: false },
    { name: 'SDK prompt with no origin', entry: { type: 'user', promptSource: 'sdk' }, want: false },
  ];

  it.each(cases)('$name', ({ entry, want }) => {
    expect(isHarnessEntry(entry)).toBe(want);
  });
});

describe('isHarnessText', () => {
  const cases: Array<{ name: string; text: string; want: boolean }> = [
    { name: 'system-reminder wrapper', text: '<system-reminder>\nnamed this session\n</system-reminder>', want: true },
    { name: 'bash-notification wrapper', text: '<bash-notification>done</bash-notification>', want: true },
    { name: 'task-notification wrapper', text: '<task-notification>\n<task-id>x</task-id>', want: true },
    { name: 'slash-command wrapper', text: '<command-name>/compact</command-name>', want: true },
    { name: 'command output wrapper', text: '<local-command-stdout>done</local-command-stdout>', want: true },
    { name: 'skill preamble', text: 'Base directory for this skill: /Users/x/.claude/skills/pjm', want: true },
    { name: 'continuation prompt (session)', text: 'This session is being continued from a previous conversation...', want: true },
    { name: 'continuation prompt (conversation)', text: 'This conversation is being continued from a previous session...', want: true },
    { name: 'JSON object', text: '{"foo":"bar"}', want: true },
    { name: 'pasted-image placeholder', text: '[Image: source: /Users/x/.claude/image-cache/a.png]', want: true },
    { name: 'pasted-image original-size note', text: '[Image: original 1920x1080, displayed at 1280x720.]', want: true },
    { name: 'interrupt notice', text: '[Request interrupted by user]', want: true },
    { name: 'interrupt notice for tool use', text: '[Request interrupted by user for tool use]', want: true },
    { name: 'JSON array', text: '[{"type":"tool_result"}]', want: true },
    { name: 'task-spawn notice', text: '{"task_id":"a7416714","tool_use_id":"toolu_016","task_type":"local_agent"}', want: true },
    { name: 'image marker then prose', text: "[Image #3] why isn't it getting our session renamed?", want: false },
    { name: 'image marker alone', text: '[Image #5]', want: false },
    { name: 'prose opening with a bracket', text: '[WIP] retry the build', want: false },
    { name: 'prose opening with a brace', text: '{maybe} we should ship it', want: false },
    { name: 'leading whitespace does not smuggle a wrapper through', text: '   <system-reminder>hi</system-reminder>', want: true },
    { name: 'plain user message', text: 'please fix the login bug', want: false },
    { name: 'relayed message text alone is indistinguishable from a real message', text: AGENT_MESSAGE_TEXT, want: false },
    { name: 'a real message that opens with a comparison', text: '< 5ms is the target for p99', want: false },
    { name: 'a real message mentioning a tag mid-sentence', text: 'wrap it in <system-reminder> tags', want: false },
  ];

  it.each(cases)('$name', ({ text, want }) => {
    expect(isHarnessText(text)).toBe(want);
  });
});

describe('isHarnessText from a human entry', () => {
  const cases: Array<{ name: string; text: string; want: boolean }> = [
    { name: 'typed slash command wrapper', text: '<command-message>android-release</command-message>\n<command-name>/android-release</command-name>', want: true },
    { name: 'JSON typed by a person', text: '{"retry": true}', want: false },
    { name: 'bracket-looking interrupt text typed by a person', text: '[Request interrupted by user] was the error', want: false },
    { name: 'image marker', text: '[Image #3] look', want: false },
    { name: 'paste wrapper', text: '<pasted_content id="x">{"a":1}</pasted_content id="x">', want: false },
    { name: 'shell-mode input', text: '<bash-input>ls</bash-input>', want: true },
    { name: 'slash command output', text: '<local-command-stdout>ok</local-command-stdout>', want: true },
    { name: 'a heart', text: '<3 thanks, that fixed it', want: false },
    { name: 'a tag named in prose', text: '<br> tags render literally in the web view', want: false },
    { name: 'an arrow', text: '<-- this button', want: false },
  ];

  it.each(cases)('$name', ({ text, want }) => {
    expect(isHarnessText(text, true)).toBe(want);
  });
});

describe('isHumanEntry', () => {
  const cases: Array<{ name: string; entry: Record<string, unknown>; want: boolean }> = [
    { name: 'typed by a person', entry: { origin: { kind: 'human' }, promptSource: 'typed' }, want: true },
    { name: 'queued by a person', entry: { origin: { kind: 'human' }, promptSource: 'queued' }, want: true },
    { name: 'task notification', entry: { origin: { kind: 'task-notification' }, promptSource: 'system' }, want: false },
    { name: 'SDK prompt with no origin', entry: { promptSource: 'sdk' }, want: true },
    { name: 'task notification delivered over the SDK', entry: { origin: { kind: 'task-notification' }, promptSource: 'sdk' }, want: false },
    { name: 'typed promptSource without origin proves nothing', entry: { promptSource: 'typed' }, want: false },
    { name: 'origin null', entry: { origin: null }, want: false },
    { name: 'origin as a bare string', entry: { origin: 'human' }, want: false },
    { name: 'no fields at all', entry: {}, want: false },
  ];

  it.each(cases)('$name', ({ entry, want }) => {
    expect(isHumanEntry(entry)).toBe(want);
  });
});

describe('isHumanRawLine', () => {
  const cases: Array<{ name: string; line: string; want: boolean }> = [
    { name: 'SDK prompt with no origin', line: '{"type":"user","uuid":"u1","promptSource":"sdk"}', want: true },
    { name: 'task notification over the SDK', line: '{"origin":{"kind":"task-notification"},"promptSource":"sdk"}', want: false },
    { name: 'human origin in the tail', line: '{"type":"user","uuid":"u1","origin":{"kind":"human"},"promptSource":"typed"}', want: true },
    { name: 'spaced JSON formatting', line: '{"origin" : { "kind" : "human" }}', want: true },
    { name: 'task-notification origin', line: '{"origin":{"kind":"task-notification"}}', want: false },
    { name: 'origin null', line: '{"origin":null,"uuid":"u1"}', want: false },
    { name: 'no origin', line: '{"type":"user","uuid":"u1"}', want: false },
  ];

  it.each(cases)('$name', ({ line, want }) => {
    expect(isHumanRawLine(line)).toBe(want);
  });
});

describe('hasHarnessFlagInRawLine', () => {
  const cases: Array<{ name: string; line: string; want: boolean }> = [
    { name: 'isMeta after the message body', line: '{"type":"user","message":{},"isMeta":true,"uuid":"u1"}', want: true },
    { name: 'isSidechain before the message body', line: '{"isSidechain":true,"type":"user","uuid":"u1"}', want: true },
    { name: 'spaced JSON formatting', line: '{"isMeta" : true, "uuid":"u1"}', want: true },
    { name: 'flags present and false', line: '{"isMeta":false,"isSidechain":false,"uuid":"u1"}', want: false },
    { name: 'no flags', line: '{"type":"user","uuid":"u1"}', want: false },
  ];

  it.each(cases)('$name', ({ line, want }) => {
    expect(hasHarnessFlagInRawLine(line)).toBe(want);
  });
});

describe('hasNonHumanOriginInRawLine', () => {
  const cases: Array<{ name: string; line: string; want: boolean }> = [
    { name: 'task-notification origin', line: '{"type":"user","origin":{"kind":"task-notification"},"uuid":"u1"}', want: true },
    { name: 'spaced JSON formatting', line: '{"origin" : { "kind" : "peer" }}', want: true },
    { name: 'human origin', line: '{"type":"user","origin":{"kind":"human"},"uuid":"u1"}', want: false },
    { name: 'no origin', line: '{"type":"user","promptSource":"sdk","uuid":"u1"}', want: false },
    { name: 'origin quoted inside text', line: '{"type":"user","message":{"content":"{\\"origin\\":{\\"kind\\":\\"x\\"}}"}}', want: false },
  ];

  it.each(cases)('$name', ({ line, want }) => {
    expect(hasNonHumanOriginInRawLine(line)).toBe(want);
  });
});

/**
 * Entries shared by the two end-to-end suites below. Each path must reach the
 * same verdict on every one.
 */
/** The shape Claude Code writes for a message with a pasted image, minus the bulk of the base64. */
const imageEntry = (uuid: string, text: string, timestamp: string, base64 = 'iVBORw0KGgo=') => ({
  parentUuid: 'p1',
  isSidechain: false,
  type: 'user',
  message: {
    role: 'user',
    content: [
      { type: 'text', text },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } },
    ],
  },
  uuid,
  timestamp,
  imagePasteIds: [3],
  permissionMode: 'default',
  origin: { kind: 'human' },
  promptSource: 'typed',
  userType: 'external',
});

const SHARED_ENTRIES: Array<{
  name: string;
  entry: Record<string, unknown>;
  visible: boolean;
  content?: string;
}> = [
  {
    name: 'relayed message from another Claude session',
    entry: {
      uuid: 'meta-relay',
      type: 'user',
      isMeta: true,
      isSidechain: false,
      message: { role: 'user', content: AGENT_MESSAGE_TEXT },
      timestamp: '2026-09-17T04:00:01.000Z',
    },
    visible: false,
  },
  {
    name: 'subagent turn',
    entry: {
      uuid: 'sidechain-1',
      type: 'user',
      isSidechain: true,
      message: { role: 'user', content: 'internal subagent prompt' },
      timestamp: '2026-09-17T04:00:02.000Z',
    },
    visible: false,
  },
  {
    name: 'system-reminder injected as a user entry',
    entry: {
      uuid: 'reminder-1',
      type: 'user',
      message: { role: 'user', content: '<system-reminder>\nnamed this session\n</system-reminder>' },
      timestamp: '2026-09-17T04:00:03.000Z',
    },
    visible: false,
  },
  {
    name: 'skill preamble',
    entry: {
      uuid: 'skill-1',
      type: 'user',
      message: { role: 'user', content: 'Base directory for this skill: /Users/x/.claude/skills/pjm' },
      timestamp: '2026-09-17T04:00:04.000Z',
    },
    visible: false,
  },
  {
    name: 'continuation prompt',
    entry: {
      uuid: 'continue-1',
      type: 'user',
      message: { role: 'user', content: 'This session is being continued from a previous conversation. Recap follows.' },
      timestamp: '2026-09-17T04:00:05.000Z',
    },
    visible: false,
  },
  {
    name: 'compaction summary',
    entry: {
      uuid: 'compact-1',
      type: 'user',
      isCompactSummary: true,
      message: { role: 'user', content: 'Summary of the conversation so far.' },
      timestamp: '2026-09-17T04:00:05.500Z',
    },
    visible: false,
  },
  {
    name: 'transcript-only entry',
    entry: {
      uuid: 'transcript-only-1',
      type: 'user',
      isVisibleInTranscriptOnly: true,
      message: { role: 'user', content: 'shown in the CLI transcript only' },
      timestamp: '2026-09-17T04:00:05.700Z',
    },
    visible: false,
  },
  {
    name: 'interrupt notice',
    entry: {
      uuid: 'interrupt-1',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
      timestamp: '2026-09-17T04:00:05.800Z',
    },
    visible: false,
  },
  {
    name: 'task-spawn notice as user content',
    entry: {
      uuid: 'spawn-1',
      type: 'user',
      message: { role: 'user', content: '{"task_id":"a7416714","tool_use_id":"toolu_016","task_type":"local_agent"}' },
      timestamp: '2026-09-17T04:00:05.850Z',
    },
    visible: false,
  },
  {
    name: 'stringified tool result as user content',
    entry: {
      uuid: 'arr-1',
      type: 'user',
      message: { role: 'user', content: '[{"type":"tool_result"}]' },
      timestamp: '2026-09-17T04:00:05.870Z',
    },
    visible: false,
  },
  {
    name: 'task notification carries a non-human origin',
    entry: {
      uuid: 'task-note-1',
      type: 'user',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
      message: { role: 'user', content: '<task-notification>\n<task-id>bc5</task-id>\n</task-notification>' },
      timestamp: '2026-09-17T04:00:05.900Z',
    },
    visible: false,
  },
  {
    name: 'pasted-image path note with no flag',
    entry: {
      uuid: 'image-note-1',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /Users/x/.claude/image-cache/a.png]' }] },
      timestamp: '2026-09-17T04:00:05.950Z',
    },
    visible: false,
  },
  {
    name: 'typed slash command carries a human origin but is a harness wrapper',
    entry: {
      uuid: 'slash-1',
      type: 'user',
      origin: { kind: 'human' },
      message: {
        role: 'user',
        content: '<command-message>android-release</command-message>\n<command-name>/android-release</command-name>',
      },
      timestamp: '2026-09-17T04:00:05.955Z',
    },
    visible: false,
  },
  {
    name: 'message with a pasted image keeps its text and marker',
    entry: imageEntry('image-1', "[Image #3] why isn't it getting our session renamed?", '2026-09-17T04:00:05.960Z'),
    visible: true,
    content: "[Image #3] why isn't it getting our session renamed?",
  },
  {
    name: 'image-only message shows its marker',
    entry: imageEntry('image-2', '[Image #5]', '2026-09-17T04:00:05.970Z'),
    visible: true,
    content: '[Image #5]',
  },
  {
    name: 'human-typed JSON is shown because origin says a person typed it',
    entry: {
      uuid: 'human-json-1',
      type: 'user',
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: '{"retry": true}' },
      timestamp: '2026-09-17T04:00:05.975Z',
    },
    visible: true,
    content: '{"retry": true}',
  },
  {
    name: 'SDK-sent message that is entirely JSON',
    entry: {
      uuid: 'sdk-json-1',
      type: 'user',
      promptSource: 'sdk',
      message: { role: 'user', content: '{"error":"device_revoked","status":401}' },
      timestamp: '2026-09-17T04:00:05.978Z',
    },
    visible: true,
    content: '{"error":"device_revoked","status":401}',
  },
  {
    name: 'human message opening with a heart',
    entry: {
      uuid: 'human-heart-1',
      type: 'user',
      origin: { kind: 'human' },
      promptSource: 'typed',
      message: { role: 'user', content: '<3 thanks, that fixed it' },
      timestamp: '2026-09-17T04:00:05.979Z',
    },
    visible: true,
    content: '<3 thanks, that fixed it',
  },
  {
    name: 'SDK-sent message opening with a bracket',
    entry: {
      uuid: 'sdk-bracket-1',
      type: 'user',
      promptSource: 'sdk',
      message: { role: 'user', content: '[WIP] retry the build' },
      timestamp: '2026-09-17T04:00:05.980Z',
    },
    visible: true,
    content: '[WIP] retry the build',
  },
  {
    name: 'SDK-sent message opening with a brace',
    entry: {
      uuid: 'sdk-brace-1',
      type: 'user',
      promptSource: 'sdk',
      message: { role: 'user', content: '{maybe} we should ship it' },
      timestamp: '2026-09-17T04:00:05.990Z',
    },
    visible: true,
    content: '{maybe} we should ship it',
  },
  {
    name: 'real user message',
    entry: {
      uuid: 'real-1',
      type: 'user',
      isMeta: false,
      isSidechain: false,
      message: { role: 'user', content: 'please fix the login bug' },
      timestamp: '2026-09-17T04:00:06.000Z',
    },
    visible: true,
    content: 'please fix the login bug',
  },
  {
    name: 'a pasted message reaches the app as its inner text',
    entry: {
      uuid: 'paste-1',
      type: 'user',
      isMeta: false,
      isSidechain: false,
      message: {
        role: 'user',
        content: '\n\n<pasted_content id="1c43">\nWe need to refire all the background agents\n</pasted_content id="1c43">\n',
      },
      timestamp: '2026-09-17T04:00:07.000Z',
    },
    visible: true,
    content: 'We need to refire all the background agents',
  },
  {
    name: 'a pasted JSON payload survives the structured-data rule',
    entry: {
      uuid: 'paste-2',
      type: 'user',
      isMeta: false,
      isSidechain: false,
      message: {
        role: 'user',
        content: '<pasted_content id="1c43">\n{"error":"boom","code":500}\n</pasted_content id="1c43">',
      },
      timestamp: '2026-09-17T04:00:08.000Z',
    },
    visible: true,
    content: '{"error":"boom","code":500}',
  },
  {
    name: 'task notification in prose, marked by its origin',
    entry: {
      parentUuid: 'p1',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'Background agent "Fix codex thread writer lock" was stopped by the user.' },
      uuid: 'bg-stopped',
      timestamp: '2026-09-17T04:00:09.000Z',
      origin: { kind: 'task-notification' },
      promptSource: 'system',
    },
    visible: false,
  },
];

describe('history path drops harness entries', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-filter-history-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(SHARED_ENTRIES)('$name', ({ entry, visible, content }) => {
    fs.writeFileSync(tempFile, JSON.stringify(entry) + '\n');
    const messages = readMessagesFromFile(tempFile, 50).messages;
    expect(messages.map((m) => m.uuid)).toEqual(visible ? [entry.uuid] : []);
    if (visible) {
      expect(messages[0].content).toBe(content);
    }
  });

  /**
   * A line over the reader's 100KB cap is truncated and recovered by regex, so
   * the flags have to be found without parsing. isMeta lands in the tail half.
   *
   * Each case is its own file: the reader recovers a single message from a file
   * of oversized lines, so pairing them in one file would let the surviving
   * entry mask the dropped one.
   */
  const oversized = (uuid: string, meta: boolean) =>
    JSON.stringify({
      isSidechain: false,
      type: 'assistant',
      message: { role: 'assistant', content: 'X'.repeat(200_000) },
      ...(meta ? { isMeta: true } : {}),
      uuid,
      timestamp: '2026-09-17T04:01:00.000Z',
    });

  it('drops an oversized entry whose isMeta survives only in the raw line', () => {
    fs.writeFileSync(tempFile, oversized('big-meta', true) + '\n');
    expect(readMessagesFromFile(tempFile, 50).messages.map((m) => m.uuid)).toEqual([]);
  });

  it('keeps an oversized entry that carries no harness flag', () => {
    fs.writeFileSync(tempFile, oversized('big-plain', false) + '\n');
    expect(readMessagesFromFile(tempFile, 50).messages.map((m) => m.uuid)).toEqual(['big-plain']);
  });

  // Real pasted-image lines run to hundreds of KB, so the text and origin are
  // recovered from the head and tail of a truncated line.
  const BIG_IMAGE = 'A'.repeat(300_000);
  const oversizedUser = (uuid: string, text: string, extra: Record<string, unknown>) =>
    JSON.stringify({
      ...imageEntry(uuid, text, '2026-09-17T04:02:00.000Z', BIG_IMAGE),
      origin: undefined,
      promptSource: undefined,
      ...extra,
    });

  it.each([
    {
      name: 'human image message',
      line: oversizedUser('big-image', "[Image #3] why isn't it getting our session renamed?", { origin: { kind: 'human' }, promptSource: 'typed' }),
      want: ["[Image #3] why isn't it getting our session renamed?"],
    },
    {
      name: 'human image-only message',
      line: oversizedUser('big-image-only', '[Image #5]', { origin: { kind: 'human' }, promptSource: 'typed' }),
      want: ['[Image #5]'],
    },
    {
      name: 'human-typed JSON beside an image',
      line: oversizedUser('big-human-json', '{"retry": true}', { origin: { kind: 'human' }, promptSource: 'typed' }),
      want: ['{"retry": true}'],
    },
    {
      name: 'queued image-first message keeps the text that follows the image',
      line: JSON.stringify({
        parentUuid: 'p1',
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BIG_IMAGE } },
            { type: 'text', text: 'Good but order is questionable' },
          ],
        },
        uuid: 'big-image-first',
        timestamp: '2026-09-17T04:02:00.000Z',
        origin: { kind: 'human' },
        promptSource: 'queued',
      }),
      want: ['Good but order is questionable'],
    },
    {
      name: 'queued image-first message with text longer than the old tail',
      line: JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BIG_IMAGE } },
            { type: 'text', text: 'log follows ' + 'L'.repeat(50_000) },
          ],
        },
        uuid: 'big-image-first-long',
        timestamp: '2026-09-17T04:02:00.000Z',
        origin: { kind: 'human' },
        promptSource: 'queued',
      }),
      want: ['log follows ' + 'L'.repeat(50_000)],
    },
    {
      name: 'text with backslashes and a tab decodes as JSON would',
      line: oversizedUser('big-escapes', '[Image #1] build fails in C:\\new\\tools\tcol2 "quoted"', { origin: { kind: 'human' } }),
      want: ['[Image #1] build fails in C:\\new\\tools\tcol2 "quoted"'],
    },
    {
      name: 'SDK image message that is entirely JSON',
      line: oversizedUser('big-sdk-json', '{"error":"device_revoked"}', { promptSource: 'sdk' }),
      want: ['{"error":"device_revoked"}'],
    },
    {
      name: 'human image message with a long cwd after origin',
      line: oversizedUser('big-long-cwd', '[Image #1] this?', {
        origin: { kind: 'human' },
        promptSource: 'typed',
        cwd: '/Users/dev/' + 'nested/'.repeat(110),
        sessionId: 'd7c5eab8-c1f2-4bae-a2d5-e27ab9e431bd',
        version: '2.1.278',
      }),
      want: ['[Image #1] this?'],
    },
    {
      name: 'SDK image message opening with a bracket',
      line: oversizedUser('big-sdk', '[WIP] see screenshot', { promptSource: 'sdk' }),
      want: ['[WIP] see screenshot'],
    },
    {
      name: 'isMeta image path note',
      line: oversizedUser('big-meta-image', '[Image: source: /Users/x/a.png]', { isMeta: true }),
      want: [],
    },
    {
      name: 'task notification marked only by its origin',
      line: oversizedUser('big-task-note', 'Background agent "X" was stopped by the user.', {
        origin: { kind: 'task-notification' },
        promptSource: 'system',
      }),
      want: [],
    },
    {
      name: 'unflagged interrupt notice',
      line: oversizedUser('big-interrupt', '[Request interrupted by user]', {}),
      want: [],
    },
    {
      name: 'unflagged JSON payload',
      line: oversizedUser('big-json', '[{"type":"tool_result"}]', {}),
      want: [],
    },
    {
      name: 'MCP tool result whose text looks like prose',
      line: JSON.stringify({
        parentUuid: 'p1',
        isSidechain: false,
        type: 'user',
        message: {
          role: 'user',
          content: [{
            tool_use_id: 'toolu_1',
            type: 'tool_result',
            content: [
              { type: 'text', text: '[computer:left_click] Clicked at (1110, 240)' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BIG_IMAGE } },
            ],
          }],
        },
        uuid: 'big-tool-result',
        timestamp: '2026-09-17T04:02:00.000Z',
        sourceToolAssistantUUID: 'a1',
      }),
      want: [],
    },
  ])('oversized: $name', ({ line, want }) => {
    expect(line.length).toBeGreaterThan(200_000);
    fs.writeFileSync(tempFile, line + '\n');
    expect(readMessagesFromFile(tempFile, 50).messages.map((m) => m.content)).toEqual(want);
  });

  // Text longer than either preserved half: the reader keeps the part it holds and
  // says so, rather than dropping a message the live path showed.
  const LONG_TEXT = 'log follows ' + 'L'.repeat(150_000) + ' end';
  const MARKER = '[… message truncated]';
  it.each([
    {
      name: 'string content',
      content: LONG_TEXT as unknown,
      kept: 'start',
    },
    {
      name: 'text block first',
      content: [{ type: 'text', text: LONG_TEXT }],
      kept: 'start',
    },
    {
      name: 'image first',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_IMAGE } },
        { type: 'text', text: LONG_TEXT },
      ],
      kept: 'end',
    },
    {
      name: 'a paste',
      content: `<pasted_content id="a1">\n${LONG_TEXT}\n</pasted_content id="a1">`,
      kept: 'start',
    },
    {
      name: 'a paste after an image',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_IMAGE } },
        { type: 'text', text: `<pasted_content id="a1">\n${LONG_TEXT}\n</pasted_content id="a1">` },
      ],
      kept: 'end',
    },
  ])('oversized text: $name keeps its $kept with a marker', ({ content, kept }) => {
    fs.writeFileSync(tempFile, JSON.stringify({
      parentUuid: 'p1',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content },
      uuid: 'big-text',
      timestamp: '2026-09-17T04:02:00.000Z',
      origin: { kind: 'human' },
      promptSource: 'typed',
    }) + '\n');
    const messages = readMessagesFromFile(tempFile, 50).messages;
    expect(messages.map((m) => m.uuid)).toEqual(['big-text']);
    const text = messages[0].content;
    if (kept === 'start') {
      expect(text.endsWith(`\n\n${MARKER}`)).toBe(true);
      expect(LONG_TEXT.startsWith(text.slice(0, -MARKER.length - 2))).toBe(true);
    } else {
      expect(text.startsWith(`${MARKER}\n\n`)).toBe(true);
      expect(LONG_TEXT.endsWith(text.slice(MARKER.length + 2))).toBe(true);
    }
    expect(text.length).toBeGreaterThan(90_000);
  });

  it.each([
    { name: 'on the escaped quote', shift: 0 },
    { name: 'one byte before it, on the backslash', shift: -1 },
    { name: 'one byte after it', shift: 1 },
  ])('oversized image-first text whose tail cut lands $name', ({ shift }) => {
    const TAIL = 100 * 1024;
    const build = (pad: number) => JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG_IMAGE } },
          { type: 'text', text: 'x'.repeat(50_000) + 'say "hi"' + 'y'.repeat(pad) },
        ],
      },
      uuid: 'img-first',
      timestamp: '2026-09-17T04:02:00.000Z',
      origin: { kind: 'human' },
      promptSource: 'typed',
    });
    // Pad so the tail's first byte is the `"` of the escaped quote, then shift.
    const probe = build(TAIL);
    const pad = TAIL + probe.indexOf('\\"hi') + 1 + TAIL - probe.length + shift;
    const line = build(pad);
    expect(line.slice(line.length - TAIL - 1 - shift, line.length - TAIL + 1 - shift)).toBe('\\"');
    fs.writeFileSync(tempFile, line + '\n');
    const messages = readMessagesFromFile(tempFile, 50).messages;
    expect(messages.map((m) => m.uuid)).toEqual(['img-first']);
    expect(messages[0].content.endsWith('hi"' + 'y'.repeat(pad))).toBe(true);
  });

  it.each([
    { name: 'Write', input: { file_path: '/x', content: 'W'.repeat(150_000) } },
    { name: 'MultiEdit', input: { file_path: '/x', edits: [{ old_string: 'a', new_string: 'W'.repeat(150_000) }] } },
  ])("does not take a $name input for an oversized assistant message's text", ({ name, input }) => {
    fs.writeFileSync(tempFile, JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name, input }],
      },
      uuid: 'big-write',
      timestamp: '2026-09-17T04:02:00.000Z',
    }) + '\n');
    expect(readMessagesFromFile(tempFile, 50).messages.map((m) => m.content)).toEqual([
      '[Message contains large content]',
    ]);
  });

  it('takes uuid and timestamp from the top level, not from a block after the image', () => {
    const entry = imageEntry('big-real-uuid', '[Image #1] see', '2026-09-17T04:02:00.000Z', BIG_IMAGE);
    (entry.message.content[1] as Record<string, unknown>).meta = { uuid: 'decoy', timestamp: '1999-01-01T00:00:00.000Z' };
    fs.writeFileSync(tempFile, JSON.stringify(entry) + '\n');
    const messages = readMessagesFromFile(tempFile, 50).messages;
    expect(messages.map((m) => [m.uuid, m.timestamp, m.content])).toEqual([
      ['big-real-uuid', '2026-09-17T04:02:00.000Z', '[Image #1] see'],
    ]);
  });

  it('keeps only the user messages when every entry is in one file', () => {
    fs.writeFileSync(
      tempFile,
      SHARED_ENTRIES.map((c) => JSON.stringify(c.entry)).join('\n') + '\n'
    );
    const visible = SHARED_ENTRIES.filter((c) => c.visible);
    const messages = readMessagesFromFile(tempFile, 50).messages;
    expect(messages.map((m) => m.uuid)).toEqual(visible.map((c) => c.entry.uuid));
    expect(messages.map((m) => m.content)).toEqual(visible.map((c) => c.content));
  });
});

/**
 * A message queued mid-turn and absorbed leaves an enqueue, a remove and a
 * `queued_command` attachment, with no `user` entry. Only the attachment says who
 * sent it, so a queue entry that looks like harness output is shown on its word alone.
 */
describe('history path for queue-only messages', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-filter-queue-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const TS = '2026-09-27T18:02:29.945Z';
  const queueOps = (content: string) => [
    { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId: 's', content },
    { type: 'queue-operation', operation: 'remove', timestamp: TS, sessionId: 's', content, reason: 'absorbed_mid_turn' },
  ];
  // The real shape, from a production transcript.
  const attachment = (prompt: unknown, fields: Record<string, unknown>) => ({
    parentUuid: 'p1',
    isSidechain: false,
    attachment: { type: 'queued_command', prompt, source_uuid: 'src-1', ...fields, timestamp: TS },
    type: 'attachment',
    uuid: 'att-1',
    timestamp: TS,
  });
  const humanQueued = (text: string, prompt: unknown = [{ type: 'text', text }]) => [
    ...queueOps(text),
    attachment(prompt, { commandMode: 'prompt', origin: { kind: 'human' }, humanTurn: true }),
  ];

  const IMAGE = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300_000) } };
  const TASK_NOTE = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n</task-notification>';
  const AGENT_NOTE = '<agent-message from="a1">\nhand-back\n</agent-message>';

  it.each([
    { name: 'JSON with trailing prose', lines: humanQueued('{"error": "device_revoked"} is what the phone shows'), want: ['{"error": "device_revoked"} is what the phone shows'] },
    { name: 'a JSON object', lines: humanQueued('{"error":"device_revoked"}'), want: ['{"error":"device_revoked"}'] },
    { name: 'a JSON array', lines: humanQueued('[1, 2, 3]'), want: ['[1, 2, 3]'] },
    { name: 'a leading tag', lines: humanQueued('<Button> is misaligned on iOS'), want: ['<Button> is misaligned on iOS'] },
    { name: 'a string prompt', lines: humanQueued('<b>bold</b>', '<b>bold</b>'), want: ['<b>bold</b>'] },
    {
      name: 'an image message whose attachment is oversized',
      lines: humanQueued('<img> tag broke', [{ type: 'text', text: '<img> tag broke' }, IMAGE]),
      want: ['<img> tag broke'],
    },
    ...['<Button> is misaligned on iOS', '{"error":"device_revoked"}', '[1, 2, 3]'].map((text) => ({
      name: `${text} sent from the app`,
      lines: [...queueOps(text), { ...attachment(text, { commandMode: 'prompt' }), entrypoint: 'sdk-cli' }],
      want: [text],
    })),
    {
      name: 'an oversized image message sent from the app',
      lines: [...queueOps('<img> tag broke'), { ...attachment([{ type: 'text', text: '<img> tag broke' }, IMAGE], { commandMode: 'prompt' }), entrypoint: 'sdk-cli' }],
      want: ['<img> tag broke'],
    },
    {
      name: 'a leading tag queued with no origin from the terminal',
      lines: [...queueOps('<Button> is misaligned on iOS'), { ...attachment('<Button> is misaligned on iOS', { commandMode: 'prompt' }), entrypoint: 'cli' }],
      want: [],
    },
    {
      name: 'a task notification queued through the SDK',
      lines: [...queueOps(TASK_NOTE), { ...attachment(TASK_NOTE, { commandMode: 'task-notification' }), entrypoint: 'sdk-cli' }],
      want: [],
    },
    { name: 'prose with no attachment', lines: queueOps('ship it'), want: ['ship it'] },
    { name: 'a leading tag with no attachment', lines: queueOps('<Button> is misaligned on iOS'), want: [] },
    {
      name: 'a task notification',
      lines: [...queueOps(TASK_NOTE), attachment(TASK_NOTE, { commandMode: 'task-notification' })],
      want: [],
    },
    {
      name: 'a relayed agent message',
      lines: [...queueOps(AGENT_NOTE), { ...attachment(AGENT_NOTE, { commandMode: 'prompt', origin: { kind: 'peer' } }), isMeta: true }],
      want: [],
    },
    {
      // isMeta sits inside the attachment, where no entry-level check sees it.
      name: 'a peer message in prose',
      lines: [
        ...queueOps('UDSTEST alpha - if you are reading this, the socket works.'),
        attachment('UDSTEST alpha - if you are reading this, the socket works.', {
          commandMode: 'prompt',
          origin: { kind: 'peer', from: 'unknown', verifiedPeerPid: 68304 },
          isMeta: true,
        }),
      ],
      want: [],
    },
    {
      name: 'a human attachment for different text',
      lines: [...queueOps('<Button> is misaligned on iOS'), ...humanQueued('something else').slice(2)],
      want: [],
    },
    {
      name: 'a slash-command wrapper',
      lines: humanQueued('<command-name>/compact</command-name>'),
      want: [],
    },
    {
      name: 'prose whose delivered entry names a non-human origin',
      lines: [
        ...queueOps('Background agent "X" was stopped by the user.'),
        {
          type: 'user',
          message: { role: 'user', content: 'Background agent "X" was stopped by the user.' },
          uuid: 'u-note',
          timestamp: TS,
          origin: { kind: 'task-notification' },
          promptSource: 'system',
        },
      ],
      want: [],
    },
  ])('$name', ({ lines, want }) => {
    fs.writeFileSync(tempFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(readMessagesFromFile(tempFile, 50).messages.map((m) => m.content)).toEqual(want);
  });

  it('shows a queued message once when its user entry follows', () => {
    const text = '<Button> is misaligned on iOS';
    const lines = [
      ...humanQueued(text),
      { type: 'user', message: { role: 'user', content: text }, uuid: 'u1', timestamp: TS, origin: { kind: 'human' }, promptSource: 'queued' },
    ];
    fs.writeFileSync(tempFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(readMessagesFromFile(tempFile, 50).messages.map((m) => m.uuid)).toEqual(['u1']);
  });
});

describe('live path drops harness entries', () => {
  let tempDir: string;
  let tempFile: string;
  let watcher: SessionWatcher;
  let events: SessionEvent[];

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-filter-live-'));
    tempFile = path.join(tempDir, 'session.jsonl');
    // A first line the watcher records as its baseline; only appends are emitted.
    fs.writeFileSync(tempFile, JSON.stringify({ uuid: 'baseline', type: 'user', message: { content: 'baseline' } }) + '\n');
    events = [];
    watcher = new SessionWatcher((event) => events.push(event));
  });

  afterEach(() => {
    watcher.unwatchAll();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits USER_MESSAGE for the real and pasted messages only', async () => {
    watcher.watchSession('filter-session', tempFile);
    await new Promise((r) => setTimeout(r, 150));

    fs.appendFileSync(
      tempFile,
      SHARED_ENTRIES.map((c) => JSON.stringify(c.entry)).join('\n') + '\n'
    );
    await new Promise((r) => setTimeout(r, 2000));

    const visible = SHARED_ENTRIES.filter((c) => c.visible);
    const userEvents = events.filter((e) => e.type === 'USER_MESSAGE');
    expect(userEvents.map((e) => e.uuid)).toEqual(visible.map((c) => c.entry.uuid));
    expect(userEvents.map((e) => e.content)).toEqual(visible.map((c) => c.content));
  });

  it('shows a human message over 100KB on both paths', async () => {
    watcher.watchSession('filter-session', tempFile);
    await new Promise((r) => setTimeout(r, 150));

    fs.appendFileSync(tempFile, JSON.stringify({
      parentUuid: 'p1',
      isSidechain: false,
      type: 'user',
      message: { role: 'user', content: 'log follows ' + 'L'.repeat(150_000) },
      uuid: 'big-live',
      timestamp: '2026-09-17T04:02:00.000Z',
      origin: { kind: 'human' },
      promptSource: 'typed',
    }) + '\n');
    await new Promise((r) => setTimeout(r, 2000));

    const live = events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.uuid);
    const history = readMessagesFromFile(tempFile, 50).messages.map((m) => m.uuid);
    expect({ live, history }).toEqual({ live: ['big-live'], history: ['baseline', 'big-live'] });
  });
});

describe('unwrapPastedContent', () => {
  const cases: Array<{ name: string; input: string; unwrapped: string; harness: boolean }> = [
    {
      name: 'a message the user pasted whole',
      input: '\n\n<pasted_content id="1c43">\nSleep for 20 seconds and then send me 200 words\n</pasted_content id="1c43">\n',
      unwrapped: 'Sleep for 20 seconds and then send me 200 words',
      harness: false,
    },
    {
      name: 'a paste sitting inside typed text',
      input: 'look at this:\n<pasted_content id="ab">\nstack trace line\n</pasted_content id="ab">\nwhat do you think?',
      unwrapped: 'look at this:\nstack trace line\nwhat do you think?',
      harness: false,
    },
    {
      name: 'two pastes in one message',
      input: '<pasted_content id="a">\nfirst\n</pasted_content id="a">\n<pasted_content id="b">\nsecond\n</pasted_content id="b">',
      unwrapped: 'first\nsecond',
      harness: false,
    },
    {
      name: 'a paste whose own text starts with a tag',
      input: '<pasted_content id="x">\n<html>\n</pasted_content id="x">',
      unwrapped: '<html>',
      harness: false,
    },
    {
      name: 'a pasted JSON payload',
      input: '<pasted_content id="x">\n{"error":"boom","code":500}\n</pasted_content id="x">',
      unwrapped: '{"error":"boom","code":500}',
      harness: false,
    },
    {
      name: 'a pasted JSON array',
      input: '<pasted_content id="x">\n[1,2,3]\n</pasted_content id="x">',
      unwrapped: '[1,2,3]',
      harness: false,
    },
    {
      name: 'a pasted merge conflict',
      input: '<pasted_content id="x">\n<<<<<<< HEAD\n</pasted_content id="x">',
      unwrapped: '<<<<<<< HEAD',
      harness: false,
    },
    {
      name: 'a harness tag that happens to contain a paste is still harness',
      input: '<local-command-stdout><pasted_content id="x">ok</pasted_content id="x"></local-command-stdout>',
      unwrapped: '<local-command-stdout>ok</local-command-stdout>',
      harness: true,
    },
    {
      name: 'bare JSON that was never pasted is still harness',
      input: '{"type":"tool_result"}',
      unwrapped: '{"type":"tool_result"}',
      harness: true,
    },
    { name: 'a task notification', input: '<task-notification>\n<task-id>bc5</task-id>\n</task-notification>', unwrapped: '<task-notification>\n<task-id>bc5</task-id>\n</task-notification>', harness: true },
    { name: 'a system reminder', input: '<system-reminder>be brief</system-reminder>', unwrapped: '<system-reminder>be brief</system-reminder>', harness: true },
    { name: 'a slash-command name', input: '<command-name>/pjm</command-name>', unwrapped: '<command-name>/pjm</command-name>', harness: true },
    { name: 'a command message', input: '<command-message>pjm is running…</command-message>', unwrapped: '<command-message>pjm is running…</command-message>', harness: true },
    { name: 'local command stdout', input: '<local-command-stdout>ok</local-command-stdout>', unwrapped: '<local-command-stdout>ok</local-command-stdout>', harness: true },
    { name: 'bash input', input: '<bash-input>ls</bash-input>', unwrapped: '<bash-input>ls</bash-input>', harness: true },
    { name: 'bash stdout', input: '<bash-stdout>file.txt</bash-stdout>', unwrapped: '<bash-stdout>file.txt</bash-stdout>', harness: true },
    { name: 'ordinary prose', input: 'Again, please', unwrapped: 'Again, please', harness: false },
    { name: 'prose that opens with a comparison', input: '< 5ms is the target', unwrapped: '< 5ms is the target', harness: false },
  ];

  // Mirrors production order: the filter decides on the raw text, because the wrapper is
  // what marks the payload as the user's; the unwrap only produces what gets displayed.
  it.each(cases)('$name', ({ input, unwrapped, harness }) => {
    expect(isHarnessText(input)).toBe(harness);
    expect(unwrapPastedContent(input)).toBe(unwrapped);
  });
});

/**
 * Gaps the reader still has. `it.failing` passes while a gap stands and fails once
 * it closes, so whoever closes one turns its test into an ordinary `it`.
 */
describe('open gaps', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-filter-gaps-'));
    tempFile = path.join(tempDir, 'session.jsonl');
    fs.writeFileSync(tempFile, JSON.stringify({ uuid: 'baseline', type: 'user', message: { content: 'baseline' } }) + '\n');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const TS = '2026-09-21T04:34:19.922Z';
  const queueOps = (content: string, ts = TS) => [
    { type: 'queue-operation', operation: 'enqueue', timestamp: ts, sessionId: 's', content },
    { type: 'queue-operation', operation: 'remove', timestamp: ts, sessionId: 's', content, reason: 'absorbed_mid_turn' },
  ];
  const humanAttachment = (text: string) => ({
    parentUuid: 'p1',
    isSidechain: false,
    attachment: { type: 'queued_command', prompt: text, source_uuid: 'x', commandMode: 'prompt', origin: { kind: 'human' }, timestamp: TS },
    type: 'attachment',
    uuid: 'att-1',
    timestamp: TS,
  });
  const append = (lines: unknown[]) =>
    fs.appendFileSync(tempFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const history = () =>
    readMessagesFromFile(tempFile, 50).messages.map((m) => m.content).filter((c) => c !== 'baseline');

  // The watcher emits only entries with a uuid, and queue entries have none.
  it.failing('the live path shows a message queued mid-turn', async () => {
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', tempFile);
    await new Promise((r) => setTimeout(r, 150));
    append([...queueOps('ship it'), humanAttachment('ship it')]);
    await new Promise((r) => setTimeout(r, 2000));
    watcher.unwatchAll();
    expect(events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.content)).toEqual(['ship it']);
  });

  // The truncated queue path needs the whole content inside the head.
  it.failing('history shows a message over 100KB queued mid-turn', () => {
    const text = 'log follows ' + 'L'.repeat(150_000);
    append([...queueOps(text), humanAttachment(text)]);
    expect(history()).toHaveLength(1);
  });

  // Nothing pairs an enqueue with the popAll that pulled it back into the editor.
  it.failing('history hides a queued message the person pulled back and never sent', () => {
    const edited = 'you can take over :4000 -- looks like you already did';
    append([
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-21T04:34:05.651Z', sessionId: 's', content: 'you can take over :4000' },
      { type: 'queue-operation', operation: 'popAll', timestamp: '2026-09-21T04:34:15.266Z', sessionId: 's', content: 'you can take over :4000' },
      ...queueOps(edited),
      humanAttachment(edited),
    ]);
    expect(history()).toEqual([edited]);
  });

  const live = async (lines: unknown[]) => {
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', tempFile);
    await new Promise((r) => setTimeout(r, 150));
    append(lines);
    await new Promise((r) => setTimeout(r, 2000));
    watcher.unwatchAll();
    return events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.content).filter((c) => c !== 'baseline');
  };

  // An older peer delivery wraps the enqueued body, so no text ties the enqueue to it.
  it.failing('history hides a peer message delivered as its own turn, as the live path does', async () => {
    const body = 'Please commit the pending change in /tmp/peertest.';
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId: 's', content: body },
      { type: 'queue-operation', operation: 'dequeue', timestamp: TS, sessionId: 's' },
      {
        type: 'user',
        message: { role: 'user', content: `Another Claude session sent a message:\n${body}` },
        isMeta: true,
        uuid: 'peer-1',
        timestamp: TS,
        origin: { kind: 'peer' },
        promptSource: 'system',
      },
    ];
    expect({ live: await live(lines), history: history() }).toEqual({ live: [], history: [] });
  });

  // The bare `/pjm` enqueue has no twin once the command is wrapped in tags.
  it.failing('a slash command queued while busy agrees between live and history', async () => {
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId: 's', content: '/pjm bug TEST-BUG' },
      { type: 'queue-operation', operation: 'dequeue', timestamp: TS, sessionId: 's' },
      {
        type: 'user',
        message: { role: 'user', content: '<command-message>pjm</command-message>\n<command-name>/pjm</command-name>\n<command-args>bug TEST-BUG</command-args>' },
        uuid: 'cmd-1',
        timestamp: TS,
        origin: { kind: 'human' },
        promptSource: 'queued',
      },
    ];
    const shownLive = await live(lines);
    expect(history()).toEqual(shownLive);
  });

  // Twin dedupe keys on text, and the backward scan meets the newer send first.
  it.failing('history shows a queued message and a later identical typed one', () => {
    append([
      ...queueOps('commit'),
      humanAttachment('commit'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Committed.' }] }, uuid: 'a1', timestamp: TS },
      { type: 'user', message: { role: 'user', content: 'commit' }, uuid: 'u2', timestamp: TS, origin: { kind: 'human' }, promptSource: 'typed' },
    ]);
    expect(history()).toEqual(['commit', 'Committed.', 'commit']);
  });

  // The attachment lands at absorption; a fetch before it moves the cursor past the enqueue.
  it.failing('an after-cursor fetch delivers a queued message whose attachment lands later', () => {
    const text = '<Button> is misaligned on iOS';
    append([
      { type: 'user', message: { role: 'user', content: 'start' }, uuid: 'u1', timestamp: TS, origin: { kind: 'human' } },
      { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId: 's', content: text },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking the build.' }] }, uuid: 'a1', timestamp: TS },
    ]);
    const first = readMessagesFromFile(tempFile, 50, undefined, 'u1').messages;
    append([humanAttachment(text), { type: 'queue-operation', operation: 'remove', timestamp: TS, sessionId: 's', content: text, reason: 'absorbed_mid_turn' }]);
    const second = readMessagesFromFile(tempFile, 50, undefined, first[first.length - 1].uuid).messages;
    expect([...first, ...second].map((m) => m.content)).toContain(text);
  });
});
