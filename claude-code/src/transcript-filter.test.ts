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
  isHarnessEntry,
  isHarnessText,
  isHumanEntry,
  isHumanQueuedCommand,
  queuedHumanMessage,
  unwrapPastedContent,
  slashCommandText,
} from './transcript-filter';
import { ReadMessageEntry, readMessagesFromFile, sourceIndexedFiles } from './message-reader';
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
    { name: 'shell output', text: '<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>', want: true },
    { name: 'prose opening with a shell tag', text: '<bash-input> is what Claude Code writes for ! commands', want: false },
    { name: 'prose opening with a command tag', text: '<command-name> tags leak into the title', want: false },
    { name: 'a command wrapper with prose after it', text: '<command-name>/x</command-name> and why is this here?', want: false },
    { name: 'mismatched closing tag', text: '<bash-input>ls</bash-stdout>', want: false },
  ];

  it.each(cases)('$name', ({ text, want }) => {
    expect(isHarnessText(text, true)).toBe(want);
  });
});

describe('slashCommandText', () => {
  const cases: Array<{ name: string; text: string; want: string | null }> = [
    { name: 'name only', text: '<command-name>/compact</command-name>', want: '/compact' },
    { name: 'message then name', text: '<command-message>ios-release</command-message>\n<command-name>/ios-release</command-name>', want: '/ios-release' },
    { name: 'args', text: '<command-message>pjm</command-message>\n<command-name>/pjm</command-name>\n<command-args>bug TEST-BUG</command-args>', want: '/pjm bug TEST-BUG' },
    { name: 'indented, empty args', text: '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>', want: '/compact' },
    { name: 'multi-line args', text: '<command-name>/pjm</command-name><command-args>one\ntwo</command-args>', want: '/pjm one\ntwo' },
    { name: 'no name', text: '<command-message>pjm</command-message>', want: null },
    { name: 'a name without a slash', text: '<command-name>pjm</command-name>', want: null },
    { name: 'text after the wrapper', text: '<command-name>/pjm</command-name> and more', want: null },
    { name: 'text before the wrapper', text: 'see <command-name>/pjm</command-name>', want: null },
    { name: 'mismatched close tag', text: '<command-name>/pjm</command-args>', want: null },
    { name: 'local command output', text: '<local-command-stdout>Compacted</local-command-stdout>', want: null },
    { name: 'shell input', text: '<bash-input>ls</bash-input>', want: null },
    { name: 'empty', text: '', want: null },
  ];

  it.each(cases)('$name', ({ text, want }) => {
    expect(slashCommandText(text)).toBe(want);
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
    name: 'typed slash command shows as its command line',
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
    visible: true,
    content: '/android-release',
  },
  {
    name: 'slash command wrapper inside a meta entry',
    entry: {
      uuid: 'slash-meta-1',
      type: 'user',
      isMeta: true,
      message: { role: 'user', content: '<command-name>/compact</command-name>' },
      timestamp: '2026-09-17T04:00:05.956Z',
    },
    visible: false,
  },
  {
    name: 'local command output',
    entry: {
      uuid: 'slash-out-1',
      type: 'user',
      message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' },
      timestamp: '2026-09-17T04:00:05.957Z',
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
 * `queued_command` attachment, with no `user` entry. The attachment is the message:
 * it names the sender, and the queue entries around it never render.
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
      // Claude Code reads a prompt with no origin as the person's, wherever it came from.
      name: 'a leading tag queued with no origin from the terminal',
      lines: [...queueOps('<Button> is misaligned on iOS'), { ...attachment('<Button> is misaligned on iOS', { commandMode: 'prompt' }), entrypoint: 'cli' }],
      want: ['<Button> is misaligned on iOS'],
    },
    {
      name: 'a task notification queued through the SDK',
      lines: [...queueOps(TASK_NOTE), { ...attachment(TASK_NOTE, { commandMode: 'task-notification' }), entrypoint: 'sdk-cli' }],
      want: [],
    },
    // Still waiting, or pulled back to the editor: it shows once the agent takes it in.
    { name: 'prose with no attachment', lines: queueOps('ship it'), want: [] },
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
      want: ['something else'],
    },
    {
      name: 'text that opens with a command wrapper',
      lines: humanQueued('<command-name>/compact</command-name>'),
      want: ['<command-name>/compact</command-name>'],
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

  it('shows a queued message once, where its source_uuid is first written', () => {
    const agent = (uuid: string, text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, uuid, timestamp: TS });
    const lines = [
      ...humanQueued('ship it'),
      agent('a1', 'Shipping.'),
      { ...humanQueued('ship it')[2], uuid: 'att-2' },
      agent('a2', 'Shipped.'),
    ];
    fs.writeFileSync(tempFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect({
      latest: readMessagesFromFile(tempFile, 50).messages.map((m) => m.uuid),
      older: readMessagesFromFile(tempFile, 50, 'a2').messages.map((m) => m.uuid),
    }).toEqual({ latest: ['src-1', 'a1', 'a2'], older: ['src-1', 'a1'] });
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

/** A queued message shows from its attachment, once, in the same place live and in history. */
describe('queued messages across live and history', () => {
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

  // The attachment has a uuid, so the watcher reads it as it reads a user entry.
  it('the live path shows a message queued mid-turn', async () => {
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', tempFile);
    await new Promise((r) => setTimeout(r, 150));
    append([...queueOps('ship it'), humanAttachment('ship it')]);
    await new Promise((r) => setTimeout(r, 2000));
    watcher.unwatchAll();
    expect(events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.content)).toEqual(['ship it']);
  });

  // The prompt opens the attachment, so the head of an oversized line holds it.
  it('history shows a message over 100KB queued mid-turn', () => {
    const text = 'log follows ' + 'L'.repeat(150_000);
    append([...queueOps(text), humanAttachment(text)]);
    expect(history()).toHaveLength(1);
  });

  // A draft pulled back to the editor is never absorbed, so it has no attachment.
  it('history hides a queued message the person pulled back and never sent', () => {
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

  // Only the delivered entry renders, and it names its peer origin.
  it('history hides a peer message delivered as its own turn, as the live path does', async () => {
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

  // Claude Code records a slash command, typed or queued, only as a tag-wrapped user
  // entry; the queue entries around it never render.
  const slashCommand = (content: string, fields: Record<string, unknown>) => ({
    type: 'user',
    message: { role: 'user', content },
    uuid: 'cmd-1',
    timestamp: TS,
    ...fields,
  });
  const slashCases = [
    {
      name: 'queued while busy, with args',
      enqueued: '/pjm bug TEST-BUG',
      entry: slashCommand('<command-message>pjm</command-message>\n<command-name>/pjm</command-name>\n<command-args>bug TEST-BUG</command-args>', { origin: { kind: 'human' }, promptSource: 'queued' }),
      want: ['/pjm bug TEST-BUG'],
    },
    {
      name: 'a skill, as Claude Code 2.1.263 writes it',
      enqueued: '/ios-release',
      entry: slashCommand('<command-message>ios-release</command-message>\n<command-name>/ios-release</command-name>', { origin: { kind: 'human' }, promptId: 'p1' }),
      want: ['/ios-release'],
    },
    {
      name: '/compact sent through the SDK, no origin',
      enqueued: '/compact',
      entry: slashCommand('<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>', { entrypoint: 'sdk-cli' }),
      want: ['/compact'],
    },
  ];
  it.each(slashCases)('a slash command shows once, live and in history: $name', async ({ enqueued, entry, want }) => {
    const lines = [
      { type: 'queue-operation', operation: 'enqueue', timestamp: TS, sessionId: 's', content: enqueued },
      { type: 'queue-operation', operation: 'dequeue', timestamp: TS, sessionId: 's' },
      entry,
      slashCommand('Base directory for this skill: /x/.claude/skills/y\n\nDo the thing.', { uuid: 'skill-1', isMeta: true, turnCompanion: true }),
    ];
    expect({ live: await live(lines), history: history() }).toEqual({ live: want, history: want });
  });

  // Identity is the source_uuid, so equal text sent twice shows twice.
  it('history shows a queued message and a later identical typed one', () => {
    append([
      ...queueOps('commit'),
      humanAttachment('commit'),
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Committed.' }] }, uuid: 'a1', timestamp: TS },
      { type: 'user', message: { role: 'user', content: 'commit' }, uuid: 'u2', timestamp: TS, origin: { kind: 'human' }, promptSource: 'typed' },
    ]);
    expect(history()).toEqual(['commit', 'Committed.', 'commit']);
  });

  // The attachment is written at absorption, after anything a client has already fetched.
  it('an after-cursor fetch delivers a queued message whose attachment lands later', () => {
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

/**
 * One real `queued_command` line per attachment layout Claude Code has written, from
 * 2.1.212 to 2.1.283, with ids, paths and text replaced. A person's message shows, as
 * its source_uuid when it has one; notifications, peers and coordinators do not.
 */
const QUEUED_LAYOUTS: Array<{ name: string; entry: Record<string, unknown>; shownAs: string | null }> = [
  {
    name: '2.1.283 task-notification: prompt, source_uuid, commandMode, timestamp',
    entry: {"parentUuid": "parent-0002", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>", "source_uuid": "src-0001", "commandMode": "task-notification", "timestamp": "2026-09-28T02:01:00.838Z"}, "type": "attachment", "uuid": "att-0003", "timestamp": "2026-09-28T02:01:00.838Z", "rendered": [{"content": "<system-reminder>\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>\n</system-reminder>"}], "renderedInHumanTurn": [{"content": "<system-reminder>\n<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>\n</system-reminder>"}], "userType": "external", "entrypoint": "sdk-cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.283", "gitBranch": "main"},
    shownAs: null,
  },
  {
    name: '2.1.283 human: prompt, source_uuid, commandMode, origin, timestamp, humanTurn',
    entry: {"parentUuid": "parent-0005", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "is the dev daemon up to date?", "source_uuid": "src-0004", "commandMode": "prompt", "origin": {"kind": "human"}, "timestamp": "2026-09-28T01:02:04.072Z", "humanTurn": true}, "type": "attachment", "uuid": "att-0006", "timestamp": "2026-09-28T01:02:04.072Z", "rendered": [{"content": "<system-reminder>\nis the dev daemon up to date?\n</system-reminder>"}], "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.283", "gitBranch": "main"},
    shownAs: 'src-0004',
  },
  {
    name: '2.1.235 task-notification: prompt, commandMode, timestamp',
    entry: {"parentUuid": "parent-0007", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command finished</summary>\n</task-notification>", "commandMode": "task-notification", "timestamp": "2026-08-30T18:21:46.016Z"}, "type": "attachment", "uuid": "att-0008", "timestamp": "2026-08-30T18:21:46.016Z", "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.235", "gitBranch": "main"},
    shownAs: null,
  },
  {
    name: '2.1.272 human: prompt, source_uuid, commandMode, origin, timestamp',
    entry: {"parentUuid": "parent-0010", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "is the dev daemon up to date?", "source_uuid": "src-0009", "commandMode": "prompt", "origin": {"kind": "human"}, "timestamp": "2026-09-15T05:20:53.409Z"}, "type": "attachment", "uuid": "att-0011", "timestamp": "2026-09-15T05:20:53.409Z", "rendered": [{"content": "<system-reminder>\nis the dev daemon up to date?\n</system-reminder>"}], "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.272", "gitBranch": "main"},
    shownAs: 'src-0009',
  },
  {
    name: '2.1.278 peer: prompt, source_uuid, commandMode, origin, timestamp, isMeta',
    entry: {"parentUuid": "parent-0013", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "<agent-message from=\"a1\">\nhand-back: the change is committed\n</agent-message>", "source_uuid": "src-0012", "commandMode": "prompt", "origin": {"kind": "peer", "from": "a1", "senderTaskId": "a1", "body": "a1", "handback": true}, "timestamp": "2026-09-21T04:50:06.551Z", "isMeta": true}, "type": "attachment", "uuid": "att-0014", "timestamp": "2026-09-21T04:50:06.551Z", "rendered": [{"content": "<system-reminder>\n<agent-message from=\"a1\">\nhand-back: the change is committed\n</agent-message>\n</system-reminder>"}], "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.278", "gitBranch": "main", "slug": "fixture-slug"},
    shownAs: null,
  },
  {
    name: '2.1.278 human: prompt, source_uuid, imagePasteIds, commandMode, origin, timestamp, humanTurn',
    entry: {"parentUuid": "parent-0016", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": [{"type": "text", "text": "is the dev daemon up to date?"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}], "source_uuid": "src-0015", "imagePasteIds": [1], "commandMode": "prompt", "origin": {"kind": "human"}, "timestamp": "2026-09-21T04:50:12.893Z", "humanTurn": true}, "type": "attachment", "uuid": "att-0017", "timestamp": "2026-09-21T04:50:12.893Z", "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.278", "gitBranch": "main", "slug": "fixture-slug"},
    shownAs: 'src-0015',
  },
  {
    name: '2.1.283 coordinator: prompt, source_uuid, origin, isMeta',
    entry: {"parentUuid": "parent-0019", "isSidechain": true, "agentId": "a1", "attachment": {"type": "queued_command", "prompt": "Stop and report what you have so far.", "source_uuid": "src-0018", "origin": {"kind": "coordinator"}, "isMeta": true}, "type": "attachment", "uuid": "att-0020", "timestamp": "2026-09-27T18:05:22.607Z", "rendered": [{"content": "<system-reminder>\nStop and report what you have so far.\n</system-reminder>"}], "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.283", "gitBranch": "main"},
    shownAs: null,
  },
  {
    name: '2.1.220 human: prompt, commandMode, origin, timestamp',
    entry: {"parentUuid": "parent-0021", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "is the dev daemon up to date?", "commandMode": "prompt", "origin": {"kind": "human"}, "timestamp": "2026-07-26T20:29:42.472Z"}, "type": "attachment", "uuid": "att-0022", "timestamp": "2026-07-26T20:29:42.472Z", "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.220", "gitBranch": "main"},
    shownAs: 'att-0022',
  },
  {
    name: '2.1.220 human: prompt, imagePasteIds, commandMode, origin, timestamp',
    entry: {"parentUuid": "parent-0023", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": [{"type": "text", "text": "is the dev daemon up to date?"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}], "imagePasteIds": [1], "commandMode": "prompt", "origin": {"kind": "human"}, "timestamp": "2026-08-10T06:40:49.764Z"}, "type": "attachment", "uuid": "att-0024", "timestamp": "2026-08-10T06:40:49.764Z", "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.220", "gitBranch": "main", "slug": "fixture-slug"},
    shownAs: 'att-0024',
  },
  {
    name: '2.1.263 human: prompt, source_uuid, imagePasteIds, commandMode, origin, timestamp',
    entry: {"parentUuid": "parent-0026", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": [{"type": "text", "text": "is the dev daemon up to date?"}, {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo="}}], "source_uuid": "src-0025", "imagePasteIds": [1], "commandMode": "prompt", "origin": {"kind": "human"}, "timestamp": "2026-09-07T06:07:34.587Z"}, "type": "attachment", "uuid": "att-0027", "timestamp": "2026-09-07T06:07:34.587Z", "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.263", "gitBranch": "main", "slug": "fixture-slug"},
    shownAs: 'src-0025',
  },
  {
    name: '2.1.272 peer: prompt, commandMode, origin, timestamp, isMeta',
    entry: {"parentUuid": "parent-0028", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "<agent-message from=\"a1\">\nhand-back: the change is committed\n</agent-message>", "commandMode": "prompt", "origin": {"kind": "peer", "from": "a1", "senderTaskId": "a1", "body": "a1", "handback": true}, "timestamp": "2026-09-16T02:34:50.685Z", "isMeta": true}, "type": "attachment", "uuid": "att-0029", "timestamp": "2026-09-16T02:34:50.685Z", "rendered": [{"content": "<system-reminder>\n<agent-message from=\"a1\">\nhand-back: the change is committed\n</agent-message>\n</system-reminder>"}], "session_id": "s-1", "userType": "external", "entrypoint": "cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.272", "gitBranch": "main", "slug": "fixture-slug"},
    shownAs: null,
  },
  {
    name: '2.1.272 sdk prompt: prompt, commandMode, timestamp',
    entry: {"parentUuid": "parent-0030", "isSidechain": false, "attachment": {"type": "queued_command", "prompt": "is the dev daemon up to date?", "commandMode": "prompt", "timestamp": "2026-09-15T06:12:19.143Z"}, "type": "attachment", "uuid": "att-0031", "timestamp": "2026-09-15T06:12:19.143Z", "rendered": [{"content": "<system-reminder>\nis the dev daemon up to date?\n</system-reminder>"}], "userType": "external", "entrypoint": "sdk-cli", "cwd": "/work/project", "sessionId": "s-1", "version": "2.1.272", "gitBranch": "main"},
    shownAs: 'att-0031',
  },
];
const QUEUED_TEXT = 'is the dev daemon up to date?';

describe('queued_command attachment layouts', () => {
  let tempDir: string;
  let tempFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-filter-layouts-'));
    tempFile = path.join(tempDir, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const history = () => readMessagesFromFile(tempFile, 50).messages.map((m) => [m.uuid, m.content, m.timestamp]);
  const want = (entry: Record<string, unknown>, shownAs: string | null, text: unknown = QUEUED_TEXT) =>
    shownAs ? [[shownAs, text, entry.timestamp]] : [];
  const watch = async (lines: unknown[]) => {
    fs.writeFileSync(tempFile, JSON.stringify({ uuid: 'baseline', type: 'user', message: { content: 'baseline' } }) + '\n');
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', tempFile);
    await new Promise((r) => setTimeout(r, 150));
    fs.appendFileSync(tempFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    await new Promise((r) => setTimeout(r, 2000));
    watcher.unwatchAll();
    return events.filter((e) => e.type !== 'VERBOSE');
  };

  it.each(QUEUED_LAYOUTS)('$name', ({ entry, shownAs }) => {
    fs.writeFileSync(tempFile, JSON.stringify(entry) + '\n');
    expect(history()).toEqual(want(entry, shownAs));
  });

  // Past 100KB the reader cuts the line; the rendered copy repeats the prompt after the ids.
  it.each(QUEUED_LAYOUTS)('$name, oversized', ({ entry, shownAs }) => {
    const attachment = entry.attachment as Record<string, unknown>;
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(300_000) } };
    const prompt = Array.isArray(attachment.prompt)
      ? [...attachment.prompt, image]
      : `${QUEUED_TEXT} ${'L'.repeat(150_000)}`;
    const copy = { content: `<system-reminder>\n${typeof prompt === 'string' ? prompt : QUEUED_TEXT}\n</system-reminder>` };
    const rendered = entry.rendered ? { rendered: [copy] } : {};
    fs.writeFileSync(tempFile, JSON.stringify({ ...entry, attachment: { ...attachment, prompt }, ...rendered }) + '\n');
    expect(history()).toEqual(want(entry, shownAs, Array.isArray(prompt) ? QUEUED_TEXT : prompt));
  });

  it('shows every layout the same live as in history', async () => {
    const live = (await watch(QUEUED_LAYOUTS.map((l) => l.entry))).map((e) => [e.uuid, e.content, e.timestamp]);
    expect(live.map(([uuid, content]) => [uuid, content])).toEqual(
      QUEUED_LAYOUTS.flatMap((l) => want(l.entry, l.shownAs)).map(([uuid, content]) => [uuid, content])
    );
    expect(history().slice(1)).toEqual(live);
  });

  it('shows a source_uuid written twice once, where it was first written', async () => {
    const first = QUEUED_LAYOUTS[1].entry;
    const agent = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Checking.' }] }, uuid: 'a1', timestamp: first.timestamp };
    const live = (await watch([first, agent, { ...first, uuid: 'att-again' }])).map((e) => e.uuid);
    expect(live).toEqual(['src-0004', 'a1']);
    expect(history().map(([uuid]) => uuid)).toEqual(['baseline', ...live]);
  });
});

describe('isHumanQueuedCommand', () => {
  const cases: Array<{ name: string; attachment: Record<string, unknown>; human: boolean }> = [
    { name: 'a human origin', attachment: { commandMode: 'prompt', origin: { kind: 'human' } }, human: true },
    { name: 'a human origin with no commandMode', attachment: { origin: { kind: 'human' } }, human: true },
    { name: 'a peer origin', attachment: { commandMode: 'prompt', origin: { kind: 'peer' } }, human: false },
    { name: 'a coordinator origin', attachment: { origin: { kind: 'coordinator' } }, human: false },
    { name: 'a task-notification origin', attachment: { commandMode: 'prompt', origin: { kind: 'task-notification' } }, human: false },
    { name: 'an origin with no kind', attachment: { commandMode: 'prompt', origin: {} }, human: false },
    { name: 'a human origin marked meta', attachment: { commandMode: 'prompt', origin: { kind: 'human' }, isMeta: true }, human: false },
    { name: 'no origin, a prompt', attachment: { commandMode: 'prompt' }, human: true },
    { name: 'a null origin, a prompt', attachment: { commandMode: 'prompt', origin: null }, human: true },
    { name: 'no origin, a task notification', attachment: { commandMode: 'task-notification' }, human: false },
    { name: 'no origin, another commandMode', attachment: { commandMode: 'bash' }, human: false },
    { name: 'no origin, no commandMode', attachment: {}, human: false },
    { name: 'no origin, a prompt marked meta', attachment: { commandMode: 'prompt', isMeta: true }, human: false },
  ];

  it.each(cases)('$name', ({ attachment, human }) => {
    expect(isHumanQueuedCommand(attachment)).toBe(human);
  });
});

describe('queuedHumanMessage', () => {
  const entry = (attachment: Record<string, unknown>, fields: Record<string, unknown> = {}) => ({
    type: 'attachment',
    uuid: 'att-1',
    attachment: { type: 'queued_command', commandMode: 'prompt', origin: { kind: 'human' }, source_uuid: 'src-1', ...attachment },
    ...fields,
  });
  const cases: Array<{ name: string; entry: Record<string, unknown>; want: [string, string] | null }> = [
    { name: 'a string prompt', entry: entry({ prompt: 'ship it' }), want: ['src-1', 'ship it'] },
    { name: 'text blocks around an image', entry: entry({ prompt: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }), want: ['src-1', 'one\ntwo'] },
    { name: 'no source_uuid', entry: entry({ prompt: 'ship it', source_uuid: undefined }), want: ['att-1', 'ship it'] },
    { name: 'no uuid at all', entry: entry({ prompt: 'ship it', source_uuid: undefined }, { uuid: undefined }), want: null },
    { name: 'a leading tag', entry: entry({ prompt: '<Button> is misaligned' }), want: ['src-1', '<Button> is misaligned'] },
    { name: 'a JSON object', entry: entry({ prompt: '{"error":"device_revoked"}' }), want: ['src-1', '{"error":"device_revoked"}'] },
    { name: 'a known harness preamble', entry: entry({ prompt: '[Request interrupted by user] then this' }), want: ['src-1', '[Request interrupted by user] then this'] },
    { name: 'a paste', entry: entry({ prompt: '<pasted_content id="p">\nlog line\n</pasted_content id="p">' }), want: ['src-1', 'log line'] },
    { name: 'a slash-command wrapper', entry: entry({ prompt: '<command-name>/compact</command-name>' }), want: ['src-1', '<command-name>/compact</command-name>'] },
    { name: 'a shell-input wrapper', entry: entry({ prompt: '<bash-input>ls</bash-input>' }), want: ['src-1', '<bash-input>ls</bash-input>'] },
    { name: 'blank text', entry: entry({ prompt: '  \n' }), want: null },
    { name: 'an image alone', entry: entry({ prompt: [{ type: 'image' }] }), want: null },
    { name: 'a sidechain entry', entry: entry({ prompt: 'ship it' }, { isSidechain: true }), want: null },
    { name: 'a meta entry', entry: entry({ prompt: 'ship it' }, { isMeta: true }), want: null },
    { name: 'a peer', entry: entry({ prompt: 'ship it', origin: { kind: 'peer' } }), want: null },
    { name: 'another attachment type', entry: { ...entry({ prompt: 'ship it' }), attachment: { type: 'edited_text_file', prompt: 'ship it' } }, want: null },
    { name: 'a user entry', entry: { ...entry({ prompt: 'ship it' }), type: 'user' }, want: null },
  ];

  it.each(cases)('$name', ({ entry, want }) => {
    const message = queuedHumanMessage(entry);
    expect(message && [message.uuid, message.text]).toEqual(want);
  });
});

// The 2.1.272+ layout: ids and flags, then a `rendered` copy of the prompt.
const realQueued = (text: string, src: string, uuid: string, ts = '2026-09-23T00:28:22.956Z') => ({
  parentUuid: 'p1',
  isSidechain: false,
  attachment: { type: 'queued_command', prompt: text, source_uuid: src, commandMode: 'prompt', origin: { kind: 'human' }, timestamp: ts, humanTurn: true },
  type: 'attachment',
  uuid,
  timestamp: ts,
  rendered: [{ content: `<system-reminder>\nThe user sent a new message while you were working:\n${text}\n</system-reminder>` }],
  userType: 'external',
  entrypoint: 'cli',
  cwd: '/work/project',
  sessionId: 's',
  version: '2.1.283',
  gitBranch: 'main',
});

const agentText = (text: string, uuid: string, ts: string) => ({
  type: 'assistant',
  uuid,
  timestamp: ts,
  message: { role: 'assistant', content: [{ type: 'text', text }], stop_reason: 'tool_use' },
});

describe('queued messages across reads', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'queued-reads-'));
    file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u0', timestamp: '2026-09-23T00:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: 'baseline' } }) + '\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const append = (lines: unknown[]) => fs.appendFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  const watch = async (lines: unknown[]) => {
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    await new Promise((r) => setTimeout(r, 150));
    append(lines);
    await new Promise((r) => setTimeout(r, 1500));
    watcher.unwatchAll();
    return events.filter((e) => e.type !== 'VERBOSE');
  };

  it('shows a queued paste over 100KB whose rendered copy fills the kept tail', async () => {
    const text = 'log follows ' + 'L'.repeat(150_000);
    const live = await watch([realQueued(text, 'src-big', 'att-big')]);
    expect(live.map((e) => e.uuid)).toEqual(['src-big']);
    expect(readMessagesFromFile(file, 50).messages.map((m) => m.uuid)).toEqual(['u0', 'src-big']);
  });

  // Appends one line per poll, the way the watcher meets a transcript being written.
  const liveByLine = (lines: unknown[]) => {
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    const w = watcher as unknown as { pollTimer: NodeJS.Timeout | null; watchedSessions: Map<string, unknown>; checkSession(s: unknown): void };
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    const session = w.watchedSessions.get('s');
    for (const line of lines) {
      append([line]);
      w.checkSession(session);
    }
    watcher.unwatchAll();
    return events.filter((e) => e.type !== 'VERBOSE').map((e) => [e.uuid, e.content, e.timestamp]);
  };
  const shown = (messages: ReadMessageEntry[]) => messages.map((m) => [m.uuid, m.content, m.timestamp]);
  const pagedOlder = (limit: number) => {
    let page = readMessagesFromFile(file, limit);
    const all = [...page.messages];
    while (page.hasMore && all.length > 0) {
      page = readMessagesFromFile(file, limit, all[0].uuid);
      if (page.messages.length === 0) break;
      all.unshift(...page.messages);
    }
    return shown(all);
  };
  const pagedNewer = (limit: number, first: string) => {
    const all: ReadMessageEntry[] = [];
    let cursor = first;
    for (;;) {
      const page = readMessagesFromFile(file, limit, undefined, cursor);
      all.push(...page.messages);
      if (!page.hasMore || !page.newestUuid) break;
      cursor = page.newestUuid;
    }
    return shown(all);
  };

  const big = 'x'.repeat(200_000);
  // A queued message keeps Claude Code's own time, the queue time, even where that is
  // earlier than the line above it; clients keep server order rather than sort by time.
  it.each([
    { name: 'after agent text', lines: [agentText('Now implementing.', 'a1', '2026-09-23T00:28:30.000Z'), realQueued('do we have a bug for this?', 'src-1', 'att-1')] },
    {
      name: 'two absorbed after a tool result',
      lines: [
        agentText('working', 'a1', '2026-09-23T10:00:05.000Z'),
        { type: 'user', uuid: 'tr', timestamp: '2026-09-23T10:00:30.000Z', sourceToolAssistantUUID: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
        realQueued('first queued', 'src-1', 'att-1', '2026-09-23T10:00:10.000Z'),
        realQueued('second queued', 'src-2', 'att-2', '2026-09-23T10:00:20.000Z'),
        agentText('done', 'a2', '2026-09-23T10:00:40.000Z'),
      ],
    },
    {
      name: 'a batch with a hook attachment between',
      lines: [
        { type: 'user', uuid: 'r1', timestamp: '2026-09-23T05:36:07.885Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } },
        realQueued('one', 'src-1', 'att-1', '2026-09-23T05:35:49.211Z'),
        { type: 'attachment', uuid: 'h1', timestamp: '2026-09-23T05:35:49.225Z', attachment: { type: 'hook_success', hookName: 'UserPromptSubmit' } },
        realQueued('two', 'src-2', 'att-2', '2026-09-23T05:36:07.270Z'),
        agentText('Both noted.', 'a2', '2026-09-23T05:36:10.000Z'),
      ],
    },
    {
      name: 'after a tool result too large to parse',
      lines: [
        agentText('working', 'a1', '2026-09-23T10:00:05.000Z'),
        { type: 'user', uuid: 'tr', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: big }] }, timestamp: '2026-09-23T10:00:30.000Z', toolUseResult: { stdout: big }, sourceToolAssistantUUID: 'a1' },
        realQueued('queued', 'src-1', 'att-1', '2026-09-23T10:00:10.000Z'),
        agentText('done', 'a2', '2026-09-23T10:00:40.000Z'),
      ],
    },
    { name: 'a paste over 100KB', lines: [agentText('working', 'a1', '2026-09-23T10:00:05.000Z'), realQueued('log ' + 'L'.repeat(150_000), 'src-1', 'att-1', '2026-09-23T10:00:01.000Z'), agentText('done', 'a2', '2026-09-23T10:00:40.000Z')] },
  ])('live, full and paged reads agree on order and time: $name', ({ lines }) => {
    const live = liveByLine(lines);
    const full = shown(readMessagesFromFile(file, 1000).messages);
    expect(full.slice(1)).toEqual(live);
    for (const line of lines as Array<{ attachment?: { source_uuid?: string }; timestamp?: string }>) {
      const source = line.attachment?.source_uuid;
      if (source) expect(full.find(([uuid]) => uuid === source)?.[2]).toBe(line.timestamp);
    }
    for (const limit of [1, 2, 3]) {
      expect(pagedOlder(limit)).toEqual(full);
      expect(pagedNewer(limit, 'u0')).toEqual(full.slice(1));
    }
  });

  // Claude Code 2.1.278 records /compact twice under one promptId: typed, then wrapped after
  // the compaction. A command opening its own prompt, or following other text, still shows.
  const promptEntry = (uuid: string, promptId: string, content: string, extra: Record<string, unknown> = {}) =>
    ({ type: 'user', uuid, promptId, timestamp: '2026-09-22T03:38:04.720Z', message: { role: 'user', content }, ...extra });
  const COMPACT_WRAPPER = '<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>';
  it.each([
    {
      name: '/compact typed, then wrapped after the compaction',
      lines: [
        agentText('Done.', 'a1', '2026-09-22T03:30:00.000Z'),
        promptEntry('c-plain', 'p-compact', '/compact'),
        { type: 'system', subtype: 'compact_boundary', uuid: 'b1', content: 'Conversation compacted', timestamp: '2026-09-22T03:38:04.725Z' },
        promptEntry('c-summary', 'p-compact', 'This session is being continued from a previous conversation that ran out of context.'),
        promptEntry('c-caveat', 'p-compact', '<local-command-caveat>Caveat: generated by local commands.</local-command-caveat>', { isMeta: true }),
        promptEntry('c-wrapped', 'p-compact', COMPACT_WRAPPER),
        promptEntry('c-stdout', 'p-compact', '<local-command-stdout>Compacted</local-command-stdout>'),
        agentText('Picking up.', 'a2', '2026-09-22T03:40:00.000Z'),
      ],
      want: ['Done.', '/compact', 'Picking up.'],
    },
    {
      name: 'a wrapped command opening its prompt',
      lines: [promptEntry('w1', 'p-pjm', '<command-name>/pjm</command-name><command-args>bug</command-args>', { origin: { kind: 'human' } }), agentText('Filed.', 'a1', '2026-09-22T03:40:00.000Z')],
      want: ['/pjm bug', 'Filed.'],
    },
    {
      // 2.1.220 and 2.1.263 write each message drained from the queue under the prompt it joins.
      name: 'the same "/…" text sent twice in one prompt',
      lines: [
        promptEntry('q1', 'p-drain', '/tmp/build.log has the error', { origin: { kind: 'human' }, promptSource: 'queued' }),
        promptEntry('q2', 'p-drain', '/tmp/build.log has the error', { origin: { kind: 'human' }, promptSource: 'queued' }),
        agentText('Looking.', 'a1', '2026-09-22T03:40:00.000Z'),
      ],
      want: ['/tmp/build.log has the error', '/tmp/build.log has the error', 'Looking.'],
    },
    {
      name: 'a different command under the same prompt',
      lines: [promptEntry('d1', 'p-two', '/Users/me/app is broken'), promptEntry('d2', 'p-two', COMPACT_WRAPPER), agentText('Ok.', 'a1', '2026-09-22T03:40:00.000Z')],
      want: ['/Users/me/app is broken', '/compact', 'Ok.'],
    },
  ])('shows a slash command once per prompt, live and on every read: $name', ({ lines, want }) => {
    const live = liveByLine(lines);
    const full = shown(readMessagesFromFile(file, 1000).messages);
    expect({ live: live.map(([, content]) => content), full: full.slice(1).map(([, content]) => content) })
      .toEqual({ live: want, full: want });
    expect(full.slice(1)).toEqual(live);
    for (const limit of [1, 2, 3]) {
      expect(pagedOlder(limit)).toEqual(full);
      expect(pagedNewer(limit, 'u0')).toEqual(full.slice(1));
    }
  });

  // Claude Code 2.1.272 records a local command sent from the app only as its queue entries
  // and a system local_command pair; a draft pulled back from the queue is never sent. Live
  // stays silent for the command so an idle task isn't flipped back to working.
  it('shows a local slash command sent from the app in history only, never a draft pulled back from the queue', () => {
    const queueOp = (operation: string, ts: string, content?: string) =>
      ({ type: 'queue-operation', operation, timestamp: ts, sessionId: 's', ...(content === undefined ? {} : { content }) });
    const localCommand = (uuid: string, content: string, ts: string) =>
      ({ type: 'system', subtype: 'local_command', content, level: 'info', timestamp: ts, uuid, isMeta: false, entrypoint: 'sdk-cli' });
    const live = liveByLine([
      queueOp('enqueue', '2026-09-16T04:00:10.000Z', 'a draft I took back'),
      queueOp('popAll', '2026-09-16T04:00:12.000Z'),
      queueOp('enqueue', '2026-09-16T04:00:23.331Z', '/status'),
      queueOp('dequeue', '2026-09-16T04:00:27.083Z'),
      localCommand('lc-cmd', '/status', '2026-09-16T04:00:27.088Z'),
      localCommand('lc-out', "<local-command-stdout>/status isn't available in this environment.</local-command-stdout>", '2026-09-16T04:00:27.089Z'),
      agentText('Next.', 'a1', '2026-09-16T04:01:00.000Z'),
    ]);
    const want = [['lc-cmd', '/status', '2026-09-16T04:00:27.088Z'], ['a1', 'Next.', '2026-09-16T04:01:00.000Z']];
    const full = shown(readMessagesFromFile(file, 1000).messages);
    expect({ live, full: full.slice(1) }).toEqual({ live: want.slice(1), full: want });
    for (const limit of [1, 2]) {
      expect(pagedOlder(limit)).toEqual(full);
      expect(pagedNewer(limit, 'u0')).toEqual(want);
    }
  });

  it.each([
    { name: '90K', text: 'start ' + 'x'.repeat(90_000) + ' END' },
    { name: '101K', text: 'start ' + 'x'.repeat(101_000) + ' END' },
    { name: '150K', text: 'start ' + 'x'.repeat(150_000) + ' END' },
    { name: '400K', text: 'start ' + 'x'.repeat(400_000) + ' END' },
    { name: '60K emoji', text: '😀'.repeat(60_000) },
    { name: 'a 200K paste', text: `<pasted_content id="p">\n${'L'.repeat(200_000)}\n</pasted_content id="p">` },
  ])('shows a queued message of $name whole, live and in history', ({ text }) => {
    const want = text.startsWith('<pasted_content') ? 'L'.repeat(200_000) : text;
    const live = liveByLine([realQueued(text, 'src-big', 'att-big')]);
    const history = readMessagesFromFile(file, 50).messages.find((m) => m.uuid === 'src-big')?.content;
    expect({ live: live.map(([, content]) => content), history }).toEqual({ live: [want], history: want });
  });

  // No size limit on either path: history parses every line whole, as live does.
  const BIG = 'A'.repeat(300_000);
  const LONG = 'log follows ' + 'L'.repeat(150_000) + ' end';
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG } };
  const human = { origin: { kind: 'human' }, promptSource: 'typed' };
  const bigUser = (uuid: string, content: unknown, extra: Record<string, unknown> = human) =>
    ({ type: 'user', uuid, timestamp: '2026-09-23T10:00:10.000Z', message: { role: 'user', content }, ...extra });
  const bigAgent = (uuid: string, content: unknown[]) =>
    ({ type: 'assistant', uuid, timestamp: '2026-09-23T10:00:20.000Z', message: { role: 'assistant', content, stop_reason: 'end_turn' } });
  const slashArgs = 'bug ' + 'log line\n'.repeat(15_000);
  it.each([
    { name: 'plain text', line: bigUser('big', LONG), want: [LONG] },
    { name: 'a text block', line: bigUser('big', [{ type: 'text', text: LONG }]), want: [LONG] },
    { name: 'a paste', line: bigUser('big', `<pasted_content id="a1">\n${LONG}\n</pasted_content id="a1">`), want: [LONG] },
    { name: 'text after an image', line: bigUser('big', [image, { type: 'text', text: LONG }]), want: [LONG] },
    { name: 'an image with a short caption', line: bigUser('big', [{ type: 'text', text: '[Image #3] why?' }, image]), want: ['[Image #3] why?'] },
    { name: 'a paste after an image', line: bigUser('big', [image, { type: 'text', text: `<pasted_content id="a1">\n${LONG}\n</pasted_content id="a1">` }]), want: [LONG] },
    { name: 'an SDK image message that is JSON', line: bigUser('big', [{ type: 'text', text: '{"error":"device_revoked"}' }, image], { promptSource: 'sdk' }), want: ['{"error":"device_revoked"}'] },
    { name: 'a queued message', line: realQueued(LONG, 'src-big', 'att-big'), want: [LONG] },
    { name: 'a queued paste', line: realQueued(`<pasted_content id="p">\n${LONG}\n</pasted_content id="p">`, 'src-big', 'att-big'), want: [LONG] },
    {
      name: 'a slash command',
      line: bigUser('big', `<command-message>pjm</command-message>\n<command-name>/pjm</command-name>\n<command-args>${slashArgs}</command-args>`),
      want: [`/pjm ${slashArgs.trim()}`],
    },
    { name: 'an agent answer', line: bigAgent('big', [{ type: 'text', text: LONG }]), want: [LONG] },
    { name: 'an isMeta image note', line: bigUser('big', [{ type: 'text', text: '[Image: source: /a.png]' }, image], { isMeta: true }), want: [] },
    { name: 'a task notification', line: bigUser('big', [{ type: 'text', text: 'Agent stopped.' }, image], { origin: { kind: 'task-notification' } }), want: [] },
    { name: 'an interrupt notice', line: bigUser('big', [{ type: 'text', text: '[Request interrupted by user]' }, image], {}), want: [] },
    {
      name: 'a tool result with an image',
      line: bigUser('big', [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'Clicked' }, image] }], { sourceToolAssistantUUID: 'a1' }),
      want: [],
    },
    { name: 'a Write call', line: bigAgent('big', [{ type: 'tool_use', id: 't', name: 'Write', input: { file_path: '/x', content: LONG } }]), want: [] },
  ])('an oversized line shows the same live and in history: $name', ({ line, want }) => {
    expect(JSON.stringify(line).length).toBeGreaterThan(100 * 1024);
    const live = liveByLine([line]).map(([, content]) => content);
    const history = readMessagesFromFile(file, 50).messages.slice(1).map((m) => m.content);
    expect({ live, history }).toEqual({ live: want, history: want });
  });

  it('live shows a queued message whose line was read half-written', () => {
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    const w = watcher as unknown as { pollTimer: NodeJS.Timeout | null; watchedSessions: Map<string, unknown>; checkSession(s: unknown): void };
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    const session = w.watchedSessions.get('s');
    const line = JSON.stringify(realQueued('ship it', 'src-p', 'att-p')) + '\n';
    fs.appendFileSync(file, line.slice(0, 200));
    w.checkSession(session);
    fs.appendFileSync(file, line.slice(200));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.uuid)).toEqual(['src-p']);
    expect(readMessagesFromFile(file, 50).messages.map((m) => m.uuid)).toEqual(['u0', 'src-p']);
  });

  it('shows a source_uuid written twice once when the copies are on different pages', () => {
    append([realQueued('first copy', 'dup', 'att-a', '2026-09-23T00:10:00.000Z')]);
    append(Array.from({ length: 40 }, (_, i) => agentText(`agent ${i} ` + 'x'.repeat(4000), `ag${i}`, `2026-09-23T00:2${Math.floor(i / 10)}:0${i % 10}.000Z`)));
    append([realQueued('first copy', 'dup', 'att-b', '2026-09-23T00:10:00.000Z'), agentText('tail', 'atail', '2026-09-23T00:59:00.000Z')]);
    const seen: string[] = [];
    let page = readMessagesFromFile(file, 5);
    seen.push(...page.messages.map((m) => m.uuid));
    while (page.hasMore && page.oldestUuid) {
      page = readMessagesFromFile(file, 5, page.oldestUuid);
      if (page.messages.length === 0) break;
      seen.unshift(...page.messages.map((m) => m.uuid));
    }
    expect(seen.filter((u) => u === 'dup')).toHaveLength(1);
    expect(seen.indexOf('dup')).toBe(1);
  });

  it('shows a queued message that starts with a command wrapper, live and in history', async () => {
    const text = '<command-name> tags are leaking into the app, look at this';
    const live = await watch([realQueued(text, 'src-cmd', 'att-cmd')]);
    expect(live.map((e) => e.content)).toEqual([text]);
    expect(readMessagesFromFile(file, 50).messages.map((m) => m.content)).toEqual(['baseline', text]);
  });

  it.each([
    '<bash-input> is what Claude Code writes for ! commands, can we render it?',
    '<command-name> tags leak into the title, see screenshot',
    '<local-command-stdout> shows up raw on Android',
  ])('shows a typed message opening with a tag name, live and in history: %s', (text) => {
    const line = { type: 'user', uuid: 'h1', timestamp: '2026-09-23T10:00:00.000Z', origin: { kind: 'human' }, promptSource: 'typed', message: { role: 'user', content: text } };
    const live = liveByLine([line]).map(([, content]) => content);
    const history = readMessagesFromFile(file, 50).messages.slice(1).map((m) => m.content);
    expect({ live, history }).toEqual({ live: [text], history: [text] });
  });

  // Clients may hold a queue-<timestamp> id from before queued messages had their own.
  it.each([
    { name: 'before', cursor: { before: 'queue-2026-09-23T00:28:25.000Z' }, want: ['u0', 'a1'] },
    { name: 'after', cursor: { after: 'queue-2026-09-23T00:28:25.000Z' }, want: ['src-1', 'a2'] },
  ])('resolves a queue cursor $name', ({ cursor, want }) => {
    append([
      agentText('Working.', 'a1', '2026-09-23T00:28:20.000Z'),
      { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-09-23T00:28:25.000Z', sessionId: 's', content: 'one' },
      realQueued('one', 'src-1', 'att-1', '2026-09-23T00:28:25.000Z'),
      { type: 'queue-operation', operation: 'remove', timestamp: '2026-09-23T00:28:26.000Z', sessionId: 's' },
      agentText('Done.', 'a2', '2026-09-23T00:28:40.000Z'),
    ]);
    expect(readMessagesFromFile(file, 50, cursor.before, cursor.after).messages.map((m) => m.uuid)).toEqual(want);
  });

  // A cursor names the copy the reader shows, never a later one.
  it.each([
    { name: 'before', before: 'src-1', after: undefined, want: ['u0'] },
    { name: 'after', before: undefined, after: 'src-1', want: ['m', 'n'] },
  ])('a $name cursor on a queued message written twice matches its first copy', ({ before, after, want }) => {
    append([
      realQueued('queued once', 'src-1', 'att-1', '2026-09-23T10:00:10.000Z'),
      agentText('between', 'm', '2026-09-23T10:00:20.000Z'),
      realQueued('queued once', 'src-1', 'att-2', '2026-09-23T10:00:25.000Z'),
      agentText('after', 'n', '2026-09-23T10:00:30.000Z'),
    ]);
    expect(readMessagesFromFile(file, 100).messages.map((m) => m.uuid)).toEqual(['u0', 'src-1', 'm', 'n']);
    expect(readMessagesFromFile(file, 100, before, after).messages.map((m) => m.uuid)).toEqual(want);
  });

  const user = (uuid: string, text: string) => ({ type: 'user', uuid, timestamp: '2026-09-23T10:00:00.000Z', origin: { kind: 'human' }, message: { role: 'user', content: text } });
  // A rewrite is read again whole; only what was never emitted is emitted. Each transcript
  // fits the first and last 4KB the watcher compares, so any rewrite of it is seen.
  it.each([
    {
      name: 'shorter, with a queued message',
      before: [user('u1', 'a long first message '.repeat(50))],
      rewrite: [user('u2', 'short'), realQueued('queued during rewrite', 'src-9', 'att-9')],
      after: [user('u3', 'next')],
      live: ['u2', 'src-9', 'u3'],
    },
    {
      name: 'as a longer transcript',
      before: [user('u1', 'hello')],
      rewrite: [agentText('x'.repeat(10), 'a0', '2026-09-23T10:00:20.000Z'), realQueued('queued msg', 'src-7', 'att-7'), agentText('reply', 'a1', '2026-09-23T10:00:20.000Z')],
      after: [],
      live: ['a0', 'src-7', 'a1'],
    },
    {
      name: 'to the same length',
      before: [user('u1', 'hello')],
      rewrite: [user('u2', 'hallo')],
      after: [user('u3', 'next')],
      live: ['u2', 'u3'],
    },
    {
      name: 'keeping what was shown',
      before: [user('u1', 'hello'), realQueued('queued', 'src-1', 'att-1')],
      rewrite: [user('u1', 'hello'), realQueued('queued', 'src-1', 'att-1b'), user('u2', 'new')],
      after: [],
      live: ['u2'],
    },
    {
      name: 'with the same bytes',
      before: [user('u1', 'hello')],
      rewrite: [user('u1', 'hello')],
      after: [user('u2', 'next')],
      live: ['u2'],
    },
  ])('live shows a transcript rewritten $name once, as history does', ({ before, rewrite, after, live }) => {
    const lines = (entries: unknown[]) => entries.map((e) => JSON.stringify(e) + '\n').join('');
    fs.writeFileSync(file, lines(before));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    const w = watcher as unknown as { pollTimer: NodeJS.Timeout | null; watchedSessions: Map<string, unknown>; checkSession(s: unknown): void };
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    const session = w.watchedSessions.get('s');
    fs.writeFileSync(file, lines(rewrite));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    w.checkSession(session);
    if (after.length) {
      append(after);
      w.checkSession(session);
    }
    w.checkSession(session);
    watcher.unwatchAll();
    const shownLive = events.filter((e) => e.type !== 'VERBOSE').map((e) => e.uuid);
    const history = readMessagesFromFile(file, 50).messages.map((m) => m.uuid);
    expect(shownLive).toEqual(live);
    expect(history.slice(history.length - live.length)).toEqual(live);
  });

  const queuedLine = JSON.stringify(realQueued('queued', 'src-1', 'att-1', '2026-09-23T10:00:10.000Z'));
  const agentLine = JSON.stringify(agentText('y', 'a1', '2026-09-23T10:00:01.000Z'));
  it.each([
    { name: 'longer', after: [agentLine, JSON.stringify(agentText('written ahead of it', 'a2', '2026-09-23T10:00:05.000Z')), queuedLine], want: ['u0', 'a1', 'a2', 'src-1'] },
    { name: 'the same length', after: [agentLine, queuedLine], want: ['u0', 'a1', 'src-1'] },
  ])('shows a queued message moved later by a rewrite $name', ({ after, want }) => {
    const baseline = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, baseline + [queuedLine, agentLine].join('\n') + '\n');
    expect(readMessagesFromFile(file, 100).messages.map((m) => m.uuid)).toEqual(['u0', 'src-1', 'a1']);
    fs.writeFileSync(file, baseline + after.join('\n') + '\n');
    expect(readMessagesFromFile(file, 100).messages.map((m) => m.uuid)).toEqual(want);
  });

  // A copy is rewritten in place to name another source. Detection is exact while the
  // indexed bytes fit the samples; past that it covers the first and last indexed blocks.
  const padded = (n: number) => Array.from({ length: n }, (_, i) => agentText(`pad ${i} ` + 'P'.repeat(8000), `pad${i}`, '2026-09-23T10:00:15.000Z'));
  const tailAgent = agentText('after', 'a9', '2026-09-23T10:00:30.000Z');
  it.each([
    { name: 'in place, same length', pad: 0, from: ['src-1', 'src-1'], to: ['src-2', 'src-1'], grow: [] as unknown[], shown: ['src-2', 'src-1'] },
    { name: 'in place, then appended to', pad: 0, from: ['src-1', 'src-1'], to: ['src-2', 'src-1'], grow: [tailAgent], shown: ['src-2', 'src-1'] },
    { name: 'at its start, then appended to, at 800KB', pad: 100, from: ['src-1', 'src-1'], to: ['src-2', 'src-1'], grow: [tailAgent], shown: ['src-2', 'src-1'] },
    {
      name: 'at its end, then appended to, at 800KB',
      pad: 100,
      from: ['src-1', 'src-9'],
      to: ['src-1', 'src-8'],
      grow: [realQueued('first send', 'src-9', 'att-C')],
      shown: ['src-1', 'src-8', 'src-9'],
    },
  ])('re-indexes a transcript rewritten $name', ({ pad, from, to, grow, shown }) => {
    const lines = (first: string, second: string) => [
      realQueued('first send', first, 'att-A'),
      agentText('mid', 'm1', '2026-09-23T10:00:20.000Z'),
      ...padded(pad),
      realQueued('first send', second, 'att-B'),
      agentText('tail', 't1', '2026-09-23T10:00:20.000Z'),
    ].map((l) => JSON.stringify(l) + '\n').join('');
    const baseline = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, baseline + lines(from[0], from[1]));
    const before = readMessagesFromFile(file, 500).messages.map((m) => m.uuid);
    expect(before.filter((u) => u.startsWith('src'))).toEqual([...new Set(from)]);
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, lines(to[0], to[1]), baseline.length);
    fs.closeSync(fd);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    if (grow.length) append(grow);
    const fresh = path.join(dir, 'fresh.jsonl');
    fs.writeFileSync(fresh, fs.readFileSync(file));
    const want = readMessagesFromFile(fresh, 500).messages.map((m) => m.uuid);
    expect(want.filter((u) => u.startsWith('src'))).toEqual(shown);
    expect(readMessagesFromFile(file, 500).messages.map((m) => m.uuid)).toEqual(want);
  });

  it('indexes at most 32 transcripts and re-indexes one it dropped', () => {
    append([realQueued('queued', 'src-1', 'att-1', '2026-09-23T10:00:10.000Z')]);
    expect(readMessagesFromFile(file, 100).messages.map((m) => m.uuid)).toEqual(['u0', 'src-1']);
    for (let i = 0; i < 40; i++) {
      const other = path.join(dir, `o${i}.jsonl`);
      fs.writeFileSync(other, JSON.stringify(realQueued('q', `o-${i}`, `att-o${i}`)) + '\n');
      readMessagesFromFile(other, 10);
    }
    expect(sourceIndexedFiles()).toBe(32);
    expect(readMessagesFromFile(file, 100).messages.map((m) => m.uuid)).toEqual(['u0', 'src-1']);
  });
});
