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
  isHarnessEntry,
  isHarnessText,
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

/**
 * Entries shared by the two end-to-end suites below. Each path must reach the
 * same verdict on every one.
 */
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
