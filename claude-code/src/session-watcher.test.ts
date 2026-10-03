/**
 * Tests for SessionWatcher file change detection
 *
 * This test verifies that the SessionWatcher reliably detects
 * file changes when an external process appends to a JSONL file
 * (simulating Claude CLI writing to session files).
 */

import * as fs from 'fs';

// A plain copy, so a test can swap a function out.
jest.mock('fs', () => ({ ...jest.requireActual('fs') }));
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SessionWatcher, SessionEvent, CompletionEvent } from './session-watcher';

describe('SessionWatcher', () => {
  let tempDir: string;
  let tempFile: string;
  let watcher: SessionWatcher;
  let events: SessionEvent[];

  beforeEach(() => {
    // Create a temp directory and file for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-watcher-test-'));
    tempFile = path.join(tempDir, 'test-session.jsonl');

    // Write initial content with uuid (required for processing)
    fs.writeFileSync(tempFile, '{"uuid":"init-1","type":"user","message":{"content":"initial message"}}\n');

    events = [];
    watcher = new SessionWatcher((event) => {
      events.push(event);
    });
  });

  afterEach(() => {
    watcher.unwatchAll();
    // Clean up temp files
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
    if (fs.existsSync(tempDir)) {
      fs.rmdirSync(tempDir);
    }
  });

  it('should detect file changes when external process appends content', async () => {
    // Start watching the file
    watcher.watchSession('test-session-123', tempFile);

    // Wait for watcher to initialize
    await sleep(100);

    // Simulate external process (Claude CLI) appending to file
    // This mimics how the CLI incrementally writes JSONL lines
    fs.appendFileSync(tempFile, '{"uuid":"resp-1","type":"assistant","message":{"content":[{"type":"text","text":"response 1"}]}}\n');

    // Wait for the watcher to detect the change
    // Using 2 seconds as a reasonable timeout - if fs.watch works, it should be much faster
    // If using polling at 500ms, we need at least that long plus processing time
    await sleep(2000);

    // The watcher should have detected the change and fired the callback
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].sessionId).toBe('test-session-123');
    expect(events[0].type).toBe('AGENT_RESPONSE');
    expect(events[0].content).toBe('response 1');
  });

  it('should detect multiple sequential appends', async () => {
    watcher.watchSession('test-session-456', tempFile);
    await sleep(100);

    // Simulate multiple rapid appends (like Claude streaming output)
    fs.appendFileSync(tempFile, '{"uuid":"line-1","type":"assistant","message":{"content":[{"type":"text","text":"line 1"}]}}\n');
    await sleep(100);
    fs.appendFileSync(tempFile, '{"uuid":"line-2","type":"assistant","message":{"content":[{"type":"text","text":"line 2"}]}}\n');
    await sleep(100);
    fs.appendFileSync(tempFile, '{"uuid":"line-3","type":"assistant","message":{"content":[{"type":"text","text":"line 3"}]}}\n');

    // Wait for detection (accounting for polling interval)
    await sleep(2000);

    // Should have detected all events
    expect(events.length).toBe(3);
    expect(events.map(e => e.content)).toEqual(['line 1', 'line 2', 'line 3']);
  });

  it('should detect file changes from external process (simulates Claude CLI)', async () => {
    // This is the critical test - external processes appending to files
    // is exactly how the Claude CLI writes to session JSONL files.
    // fs.watch() on macOS often fails to detect these changes.
    watcher.watchSession('test-session-external', tempFile);
    await sleep(100);

    // Use shell to append - this is an external process, just like Claude CLI
    const jsonLine = '{"uuid":"ext-1","type":"assistant","message":{"content":[{"type":"text","text":"external append"}]}}';
    execSync(`echo '${jsonLine}' >> "${tempFile}"`);

    // Wait for detection
    await sleep(2000);

    // The watcher MUST detect changes from external processes
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].sessionId).toBe('test-session-external');
    expect(events[0].type).toBe('AGENT_RESPONSE');
  });

  it('should emit VERBOSE for tool_use entries', async () => {
    watcher.watchSession('test-session-tool', tempFile);
    await sleep(100);

    // Append a tool_use entry
    const toolEntry = '{"uuid":"tool-1","type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/test/file.ts"}}]}}';
    fs.appendFileSync(tempFile, toolEntry + '\n');

    await sleep(2000);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('VERBOSE');
    expect(events[0].content).toContain('Reading');
  });

  it('should emit USER_MESSAGE for user entries', async () => {
    watcher.watchSession('test-session-user', tempFile);
    await sleep(100);

    // Append a user message entry
    const userEntry = '{"uuid":"user-1","type":"user","message":{"content":"hello agent"}}';
    fs.appendFileSync(tempFile, userEntry + '\n');

    await sleep(2000);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('USER_MESSAGE');
    expect(events[0].content).toBe('hello agent');
  });

  it('should skip task-notification user entries (system messages)', async () => {
    watcher.watchSession('test-session-tasknotif', tempFile);
    await sleep(100);

    // Append a task-notification entry (injected by Claude Code as user type)
    const taskNotif = '{"uuid":"notif-1","type":"user","message":{"content":"<task-notification>\\n<task-id>a07152b</task-id>\\n<status>completed</status>\\n<summary>Agent completed</summary>\\n</task-notification>"}}';
    fs.appendFileSync(tempFile, taskNotif + '\n');

    // Also append a real user message to confirm filtering is selective
    const userEntry = '{"uuid":"user-2","type":"user","message":{"content":"real user message"}}';
    fs.appendFileSync(tempFile, userEntry + '\n');

    await sleep(2000);

    // Only the real user message should be emitted
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('USER_MESSAGE');
    expect(events[0].content).toBe('real user message');
  });

  it('should skip JSON content in user entries (task spawn notifications, etc.)', async () => {
    watcher.watchSession('test-session-json', tempFile);
    await sleep(100);

    // Append a JSON task spawn notification (written by Claude Code for Task tool)
    const taskSpawn = '{"uuid":"spawn-1","type":"user","message":{"content":"{\\"task_id\\":\\"a7416714da1e3efb3\\",\\"tool_use_id\\":\\"toolu_016pRV3JCgTzyFsidbbAfbZY\\",\\"description\\":\\"Explore daemon error reporting\\",\\"task_type\\":\\"local_agent\\"}"}}';
    fs.appendFileSync(tempFile, taskSpawn + '\n');

    // Append a JSON array content
    const arrayContent = '{"uuid":"arr-1","type":"user","message":{"content":"[{\\"type\\":\\"tool_result\\"}]"}}';
    fs.appendFileSync(tempFile, arrayContent + '\n');

    // Append a system-reminder tag
    const sysReminder = '{"uuid":"sys-1","type":"user","message":{"content":"<system-reminder>Some reminder</system-reminder>"}}';
    fs.appendFileSync(tempFile, sysReminder + '\n');

    // Append a real user message
    const userEntry = '{"uuid":"user-3","type":"user","message":{"content":"what is the status?"}}';
    fs.appendFileSync(tempFile, userEntry + '\n');

    await sleep(2000);

    // Only the real user message should be emitted
    expect(events.length).toBe(1);
    expect(events[0].type).toBe('USER_MESSAGE');
    expect(events[0].content).toBe('what is the status?');
  });

  it('should fire completion when system entry appears after agent activity', async () => {
    const completions: CompletionEvent[] = [];
    watcher = new SessionWatcher(
      (event) => { events.push(event); },
      (completion) => { completions.push(completion); }
    );
    watcher.watchSession('test-session-123', tempFile);
    await sleep(100);

    // User sends a message
    fs.appendFileSync(tempFile, '{"uuid":"user-1","type":"user","message":{"content":"fix the bug"}}\n');
    await sleep(600);

    // Agent responds with tool calls
    fs.appendFileSync(tempFile, '{"uuid":"tool-1","type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_1","name":"Edit","input":{}}]}}\n');
    await sleep(600);

    // Tool result
    fs.appendFileSync(tempFile, '{"uuid":"result-1","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"done"}]}}\n');
    await sleep(600);

    // Agent's final text response
    fs.appendFileSync(tempFile, '{"uuid":"resp-1","type":"assistant","parentUuid":"result-1","message":{"content":[{"type":"text","text":"Done – fixed the null pointer."}]}}\n');
    await sleep(600);

    // No completion yet – no system entry
    expect(completions.length).toBe(0);

    // System entry marks end of turn
    fs.appendFileSync(tempFile, '{"uuid":"sys-1","type":"system","subtype":"turn_duration","message":{"content":""}}\n');
    await sleep(600);

    expect(completions.length).toBe(1);
    expect(completions[0].sessionId).toBe('test-session-123');
  });

  it('should NOT fire completion on system entry when user replied in same batch', async () => {
    const completions: CompletionEvent[] = [];
    watcher = new SessionWatcher(
      (event) => { events.push(event); },
      (completion) => { completions.push(completion); }
    );
    watcher.watchSession('test-session-123', tempFile);
    await sleep(100);

    // System entry and user message arrive in the same batch
    fs.appendFileSync(tempFile,
      '{"uuid":"sys-2","type":"system","message":{"content":""}}\n' +
      '{"uuid":"user-2","type":"user","message":{"content":"now do the other thing"}}\n'
    );
    await sleep(600);

    // No completion – user already replied
    expect(completions.length).toBe(0);
  });

  it('should NOT re-fire completion when a second system entry appears with no new assistant turn', async () => {
    const completions: CompletionEvent[] = [];
    watcher = new SessionWatcher(
      (event) => { events.push(event); },
      (completion) => { completions.push(completion); }
    );
    watcher.watchSession('test-session-dupe', tempFile);
    await sleep(100);

    // A prompt, its reply and a turn-ending system entry: fires once
    fs.appendFileSync(tempFile, '{"uuid":"q-dup","type":"user","origin":{"kind":"human"},"message":{"role":"user","content":"go"}}\n');
    fs.appendFileSync(tempFile, '{"uuid":"resp-dup","type":"assistant","parentUuid":"q-dup","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"All done."}]}}\n');
    await sleep(600);
    fs.appendFileSync(tempFile, '{"uuid":"sys-first","type":"system","subtype":"turn_duration","parentUuid":"resp-dup","message":{"content":""}}\n');
    await sleep(600);

    expect(completions.length).toBe(1);

    // A delayed second end marker arrives later (e.g. hook write) – must NOT
    // re-fire because the assistant turn (resp-dup) hasn't advanced.
    fs.appendFileSync(tempFile, '{"uuid":"sys-late","type":"system","subtype":"stop_hook_summary","parentUuid":"sys-first","message":{"content":""}}\n');
    await sleep(1000);

    expect(completions.length).toBe(1);
  });

  it('announces a turn the adapter prompted on its result, not on its end markers', async () => {
    const completions: CompletionEvent[] = [];
    watcher = new SessionWatcher(
      (event) => { events.push(event); },
      (completion) => { completions.push(completion); },
      () => true
    );
    watcher.watchSession('test-session-sdk', tempFile);
    await sleep(100);

    const now = new Date().toISOString();
    fs.appendFileSync(tempFile, `{"uuid":"sdk-q","type":"user","timestamp":"${now}","promptSource":"sdk","message":{"role":"user","content":"from the app"}}\n`);
    fs.appendFileSync(tempFile, '{"uuid":"resp-sdk","type":"assistant","parentUuid":"sdk-q","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"Done."}]}}\n');
    await sleep(600);
    expect(completions.length).toBe(0);

    fs.appendFileSync(tempFile, '{"uuid":"sys-sdk","type":"system","subtype":"turn_duration","parentUuid":"resp-sdk","message":{"content":""}}\n');
    await sleep(1000);
    expect(completions.length).toBe(0);

    expect(watcher.announceTurn('test-session-sdk')).toBe(true);
    expect(completions.length).toBe(1);
    expect(completions[0].lastMessage).toBe('Done.');
    expect(watcher.announceTurn('unwatched')).toBe(false);
  });

  it('should NOT fire completion on intermediate agent responses mid-turn', async () => {
    const completions: CompletionEvent[] = [];
    watcher = new SessionWatcher(
      (event) => { events.push(event); },
      (completion) => { completions.push(completion); }
    );
    watcher.watchSession('test-session-123', tempFile);
    await sleep(100);

    // Agent says something, then makes a tool call – no system entry
    fs.appendFileSync(tempFile, '{"uuid":"resp-3","type":"assistant","message":{"content":[{"type":"text","text":"Let me read the file."}]}}\n');
    await sleep(600);

    fs.appendFileSync(tempFile, '{"uuid":"tool-3","type":"assistant","message":{"content":[{"type":"tool_use","id":"toolu_3","name":"Read","input":{}}]}}\n');
    await sleep(600);

    fs.appendFileSync(tempFile, '{"uuid":"result-3","type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_3","content":"file contents"}]}}\n');
    await sleep(600);

    fs.appendFileSync(tempFile, '{"uuid":"resp-4","type":"assistant","parentUuid":"result-3","message":{"content":[{"type":"text","text":"Now I see the issue. Let me fix it."}]}}\n');
    await sleep(2000);

    // No completion – no system entry, agent is still working
    expect(completions.length).toBe(0);
  });
});
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('SessionWatcher start-up reads', () => {
  // Written before any watch in these tests began, unless stamped otherwise.
  const OLD = '2026-01-01T00:00:00.000Z';
  const later = () => new Date(Date.now() + 1000).toISOString();
  const line = (uuid: string, text: string, timestamp = OLD) =>
    JSON.stringify({ type: 'user', uuid, timestamp, origin: { kind: 'human' }, message: { role: 'user', content: text } }) + '\n';
  const agent = (uuid: string, text: string, timestamp = OLD) => JSON.stringify({ type: 'assistant', uuid, timestamp,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }) + '\n';
  let dir: string;
  let file: string;
  let restore: Array<() => void>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-init-'));
    file = path.join(dir, 's.jsonl');
    restore = [];
  });
  afterEach(() => {
    restore.forEach((undo) => undo());
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Each fault is installed before watchSession; `during` says whether it outlives it.
  // The first `times` of these calls to reach the transcript fail, whichever they are.
  const failOnce = (names: Array<'openSync' | 'readSync' | 'readFileSync'> = ['readSync', 'readFileSync'], code = 'EBUSY', times = 1) => () => {
    const mocked = jest.requireMock<typeof fs>('fs');
    const real = Object.fromEntries(names.map((n) => [n, mocked[n]])) as Record<string, (...a: unknown[]) => unknown>;
    let failures = 0;
    Object.assign(mocked, Object.fromEntries(names.map((n) => [n, (...a: unknown[]) => {
      if (failures < times) { failures++; throw Object.assign(new Error(code), { code }); }
      return real[n](...a);
    }])));
    return () => Object.assign(mocked, real);
  };
  // Stands in for V8's ~512MB string limit at 64KB, so the transcript can stay small.
  const stringLimit = () => {
    const toString = Buffer.prototype.toString;
    const spy = jest.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, ...args: unknown[]) {
      if (this.length > 64 * 1024) throw Object.assign(new Error('Cannot create a string longer than 64KB'), { code: 'ERR_STRING_TOO_LONG' });
      return (toString as (...a: unknown[]) => string).apply(this, args);
    });
    return () => spy.mockRestore();
  };

  it.each([
    { name: 'a read that fails while watching starts', fault: failOnce(), during: 'start' },
    { name: 'a transcript too long to decode as one string', fault: stringLimit, during: 'polls' },
  ])('shows only what is appended after $name', ({ fault, during }) => {
    fs.writeFileSync(file, Array.from({ length: 200 }, (_, i) => line(`old-${i}`, `old ${i} ` + 'x'.repeat(1000))).join(''));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    const undo = fault();
    restore.push(undo);
    watcher.watchSession('s', file);
    if (during === 'start') undo();
    const w = watcher as unknown as { pollTimer: NodeJS.Timeout | null; watchedSessions: Map<string, unknown>; checkSession(s: unknown): void };
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    const session = w.watchedSessions.get('s');
    expect(session).toBeDefined();
    w.checkSession(session);
    fs.appendFileSync(file, line('new-1', 'new one'));
    w.checkSession(session);
    fs.appendFileSync(file, line('new-2', 'new two'));
    w.checkSession(session);
    watcher.unwatchAll();
    undo();
    expect(events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.content)).toEqual(['new one', 'new two']);
  });

  const internals = (watcher: SessionWatcher) => {
    const w = watcher as unknown as { pollTimer: NodeJS.Timeout | null; watchedSessions: Map<string, { lastSize: number }>; checkSession(s: unknown): void };
    if (w.pollTimer) clearInterval(w.pollTimer);
    w.pollTimer = null;
    return w;
  };
  const shown = (events: SessionEvent[]) => events.filter((e) => e.type === 'USER_MESSAGE').map((e) => e.content);

  it('keeps watching when the transcript cannot be opened as watching starts', () => {
    fs.writeFileSync(file, line('old-1', 'old'));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    const undo = failOnce(['openSync', 'readFileSync'])();
    restore.push(undo);
    watcher.watchSession('s', file);
    undo();
    expect(watcher.watchCount).toBe(1);
    const w = internals(watcher);
    const session = w.watchedSessions.get('s');
    w.checkSession(session);
    fs.appendFileSync(file, line('new-1', 'typed after watching started'));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(shown(events)).toEqual(['typed after watching started']);
  });

  it('retries a start when the transcript cannot even be stat-ed', () => {
    const sub = path.join(dir, 'proj');
    fs.mkdirSync(sub);
    const inner = path.join(sub, 's.jsonl');
    fs.writeFileSync(inner, line('old-1', 'old'));
    restore.push(() => { fs.chmodSync(sub, 0o755); fs.chmodSync(inner, 0o644); });
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    fs.chmodSync(inner, 0o000);
    watcher.watchSession('s', inner);
    const w = internals(watcher);
    const session = w.watchedSessions.get('s');
    fs.chmodSync(sub, 0o000);
    w.checkSession(session);
    fs.chmodSync(sub, 0o755);
    fs.chmodSync(inner, 0o644);
    expect(watcher.watchCount).toBe(1);
    w.checkSession(session);
    fs.appendFileSync(inner, line('new-1', 'after recovery'));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(shown(events)).toEqual(['after recovery']);
  });

  it('stops watching a session that has not started once its transcript is gone', () => {
    fs.writeFileSync(file, line('old-1', 'old'));
    const watcher = new SessionWatcher(() => {});
    const undo = failOnce()();
    restore.push(undo);
    watcher.watchSession('s', file);
    undo();
    fs.unlinkSync(file);
    const w = internals(watcher);
    w.checkSession(w.watchedSessions.get('s'));
    expect(watcher.watchCount).toBe(0);
  });

  it('sends a turn that ends while unstarted and fires its completion once', () => {
    fs.writeFileSync(file, line('old-1', 'old question') + agent('a-1', 'old answer'));
    const events: SessionEvent[] = [];
    let completions = 0;
    const watcher = new SessionWatcher((e) => events.push(e), () => { completions++; });
    const undo = failOnce()();
    restore.push(undo);
    watcher.watchSession('s', file);
    undo();
    fs.appendFileSync(file, line('new-1', 'new question', later()) + agent('a-2', 'new answer', later()));
    const w = internals(watcher);
    for (let poll = 0; poll < 3; poll++) w.checkSession(w.watchedSessions.get('s'));
    watcher.unwatchAll();
    expect(events.map((e) => e.content)).toEqual(['new question', 'new answer']);
    expect(completions).toBe(1);
  });

  it('retries a start whose read the file was truncated under', () => {
    const content = line('old-1', 'old question') + agent('a-1', 'old answer');
    fs.writeFileSync(file, content);
    const mocked = jest.requireMock<typeof fs>('fs');
    const readSync = mocked.readSync;
    let truncate = true;
    mocked.readSync = ((...a: Parameters<typeof fs.readSync>) => {
      if (truncate) { truncate = false; fs.truncateSync(file, 0); }
      return readSync(...a);
    }) as typeof fs.readSync;
    restore.push(() => { mocked.readSync = readSync; });
    const events: SessionEvent[] = [];
    let completions = 0;
    const watcher = new SessionWatcher((e) => events.push(e), () => { completions++; });
    watcher.watchSession('s', file);
    mocked.readSync = readSync;
    fs.writeFileSync(file, content);
    const w = internals(watcher);
    w.checkSession(w.watchedSessions.get('s'));
    w.checkSession(w.watchedSessions.get('s'));
    watcher.unwatchAll();
    expect(events).toEqual([]);
    expect(completions).toBe(0);
  });

  it('runs no poll timer when the only watch start finds the file gone', () => {
    fs.writeFileSync(file, '');
    const undo = failOnce(['openSync'], 'ENOENT')();
    restore.push(undo);
    const watcher = new SessionWatcher(() => {});
    watcher.watchSession('s', file);
    undo();
    const pollTimer = (watcher as unknown as { pollTimer: NodeJS.Timeout | null }).pollTimer;
    watcher.unwatchAll();
    expect(watcher.watchCount).toBe(0);
    expect(pollTimer).toBeNull();
  });

  it('starts over from what is there when a failed start is retried after a replacement', () => {
    fs.writeFileSync(file, line('old-1', 'old one') + line('old-2', 'old two'));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    const undo = failOnce()();
    restore.push(undo);
    watcher.watchSession('s', file);
    undo();
    fs.writeFileSync(file + '.tmp', line('new-a', 'at the head') + line('old-1', 'old one') + line('old-2', 'old two') + line('new-b', 'at the end'));
    fs.renameSync(file + '.tmp', file);
    const w = internals(watcher);
    const session = w.watchedSessions.get('s');
    w.checkSession(session);
    w.checkSession(session);
    fs.appendFileSync(file, line('new-c', 'after the start'));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(shown(events)).toEqual(['after the start']);
  });

  it('shows a message that was half written when watching started', () => {
    const pending = line('new-1', 'typed while watching started');
    fs.writeFileSync(file, line('old-1', 'old') + pending.slice(0, 40));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    const w = internals(watcher);
    const session = w.watchedSessions.get('s');
    fs.appendFileSync(file, pending.slice(40));
    w.checkSession(session);
    fs.appendFileSync(file, line('new-2', 'next message'));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(shown(events)).toEqual(['typed while watching started', 'next message']);
  });

  it('passes over a last line too long to decode once, not every poll', () => {
    fs.writeFileSync(file, line('old-1', 'old'));
    const watcher = new SessionWatcher(() => {});
    watcher.watchSession('s', file);
    const w = internals(watcher);
    const session = w.watchedSessions.get('s')!;
    fs.appendFileSync(file, line('huge', 'x'.repeat(100 * 1024)));
    restore.push(stringLimit());
    const skips = jest.spyOn(console, 'error').mockImplementation(() => {});
    restore.push(() => skips.mockRestore());
    for (let poll = 0; poll < 3; poll++) w.checkSession(session);
    watcher.unwatchAll();
    expect(skips.mock.calls.filter(([m]) => String(m).includes('Skipping'))).toHaveLength(1);
    expect(session.lastSize).toBe(fs.statSync(file).size);
  });

  it('keeps old entries unsent when a failed start-up read is followed by a rewrite', () => {
    fs.writeFileSync(file, Array.from({ length: 5 }, (_, i) => line(`old-${i}`, `old ${i}`)).join(''));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    const undo = failOnce()();
    restore.push(undo);
    watcher.watchSession('s', file);
    undo();
    const w = internals(watcher);
    const session = w.watchedSessions.get('s');
    w.checkSession(session);
    // Same size, new mtime: read again from the start.
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    w.checkSession(session);
    fs.appendFileSync(file, line('new-1', 'new one'));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(shown(events)).toEqual(['new one']);
  });

  it('skips only the entry that cannot be handled, not the rest of its poll', () => {
    fs.writeFileSync(file, line('old-1', 'old'));
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    const w = internals(watcher);
    const session = w.watchedSessions.get('s');
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    restore.push(() => errors.mockRestore());
    fs.appendFileSync(file, line('a', 'first') +
      JSON.stringify({ type: 'assistant', uuid: 'bad', message: { role: 'assistant', content: [null] } }) + '\n' +
      line('b', 'typed right after'));
    w.checkSession(session);
    fs.appendFileSync(file, line('c', 'next turn'));
    w.checkSession(session);
    watcher.unwatchAll();
    expect(shown(events)).toEqual(['first', 'typed right after', 'next turn']);
    expect(errors.mock.calls.some(([m]) => String(m).includes('Skipping entry bad'))).toBe(true);
  });

  it('notices a transcript replaced while watching starts', () => {
    fs.writeFileSync(file, Array.from({ length: 50 }, (_, i) => line(`old-${i}`, `old ${i} ` + 'x'.repeat(1000))).join(''));
    const mocked = jest.requireMock<typeof fs>('fs');
    const readSync = mocked.readSync;
    let swapped = false;
    mocked.readSync = ((...a: Parameters<typeof fs.readSync>) => {
      const n = readSync(...a);
      if (!swapped) {
        swapped = true;
        // Larger than what it replaces, so it cannot pass for a shrunk file.
        fs.writeFileSync(file + '.tmp', Array.from({ length: 60 }, (_, i) => line(`new-${i}`, `new ${i} ` + 'y'.repeat(1000))).join(''));
        fs.renameSync(file + '.tmp', file);
      }
      return n;
    }) as typeof fs.readSync;
    restore.push(() => { mocked.readSync = readSync; });
    const events: SessionEvent[] = [];
    const watcher = new SessionWatcher((e) => events.push(e));
    watcher.watchSession('s', file);
    mocked.readSync = readSync;
    const w = internals(watcher);
    w.checkSession(w.watchedSessions.get('s'));
    watcher.unwatchAll();
    expect(swapped).toBe(true);
    expect(shown(events)).toHaveLength(60);
    expect(shown(events)[0]).toMatch(/^new 0 /);
  });


  // The watcher announces every completed turn exactly once. A turn this daemon's adapter
  // prompted (its prompt falls inside an adapter query span and no person typed it) is
  // announced when the adapter hands over its `result`; every other turn is announced at
  // the end marker in the transcript. Entries chain by parentUuid as Claude Code writes them.
  describe('turn completion ownership', () => {
    type E = Record<string, unknown>;
    // Transcript time, one second per entry written, so a span opened between two
    // batches falls between their stamps.
    let clock = 0;
    let prev: string | undefined;
    let span: { from: number; to?: number } | null = null;
    const tick = () => new Date(clock += 1000).toISOString();
    const hadQuery = (at: number) => !!span && at >= span.from && (span.to === undefined || at <= span.to);
    const J = (entries: E[]) => entries.map((e) => {
      const chained = { parentUuid: prev, timestamp: tick(), ...e };
      prev = e.uuid as string;
      return JSON.stringify(chained) + '\n';
    }).join('');
    const from = (parent: string, e: E): E => ({ ...e, parentUuid: parent });
    const withAt = (ts: string | undefined, e: E): E => (ts ? { ...e, timestamp: ts } : e);

    const sdk = (uuid: string, text: string, ts?: string) => withAt(ts, { type: 'user', uuid, promptSource: 'sdk', message: { role: 'user', content: text } });
    const terminal = (uuid: string, text: string, ts?: string) => withAt(ts, { type: 'user', uuid, promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: text } });
    const queuedPrompt = (uuid: string, text: string) => ({ ...terminal(uuid, text), promptSource: 'queued' });
    const notification = (uuid: string, promptSource: string) =>
      ({ type: 'user', uuid, promptSource, origin: { kind: 'task-notification' }, message: { role: 'user', content: '<task-notification>done</task-notification>' } });
    const meta = (uuid: string) => ({ type: 'user', uuid, isMeta: true, message: { role: 'user', content: '<local-command-caveat>hidden</local-command-caveat>' } });
    const compactSummary = (uuid: string) => ({ type: 'user', uuid, isCompactSummary: true, message: { role: 'user', content: 'This session is being continued...' } });
    const answer = (uuid: string, text: string, ts?: string) => withAt(ts, { type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } });
    const thinking = (uuid: string) => ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'hm' }] } });
    const system = (uuid: string, subtype: string) => ({ type: 'system', subtype, uuid, message: { content: '' } });
    const toolUse = (uuid: string, name = 'Bash') =>
      ({ type: 'assistant', uuid, message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu-' + uuid, name, input: { command: 'sleep 100' } }] } });
    const toolResult = (uuid: string, parent: string, text = 'ok') =>
      ({ type: 'user', uuid, sourceToolAssistantUUID: parent, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-' + parent, content: text }] } });
    const interrupt = (uuid: string) => ({ type: 'user', uuid, message: { role: 'user', content: '[Request interrupted by user]' } });
    const apiError = (uuid: string) =>
      ({ type: 'assistant', uuid, isApiErrorMessage: true, message: { role: 'assistant', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } });
    const queued = (uuid: string) => ({ type: 'attachment', uuid, attachment: { type: 'queued_command', prompt: 'and this' } });

    // Turn 1 ends without any marker the watcher could fire on.
    const markerless = {
      'interrupted during a tool': (prompt: E) => [prompt, toolUse('t-1'), toolResult('r-1', 't-1', '[Request interrupted by user for tool use]')],
      'ended by an API error': (prompt: E) => [prompt, apiError('e-1')],
      'cut off at max turns': (prompt: E) => [prompt, toolUse('t-1'), toolResult('r-1', 't-1')],
    };

    /** Entries appended and polled as one batch, or what happens between batches. */
    type Step = E[] | 'RESULT' | 'OPEN' | 'CLOSE' | 'OPEN-BEFORE';
    type Case = {
      name: string;
      /** Transcript before watching starts; entries older than the watch. */
      history?: () => E[];
      /** Start-up reads that fail and are retried on the following polls. */
      startFails?: number;
      /** Built when the test runs so the entries post-date the watch. */
      steps: () => Step[];
      /** Completions the watcher announces, all told. */
      fires: number;
    };
    const cases: Case[] = [
      { name: 'a terminal turn, watched from before it starts', steps: () => [[terminal('u', 'q'), answer('a', 'done')]], fires: 1 },
      { name: 'a terminal turn typed while the adapter has a query', steps: () => ['OPEN', [terminal('u', 'q'), answer('a', 'done'), system('s', 'turn_duration')]], fires: 1 },
      { name: 'an app turn, watched from before it starts', steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')], 'RESULT'], fires: 1 },
      { name: 'an app turn arriving one entry per poll', steps: () => ['OPEN', [sdk('u', 'q')], [answer('a', 'done')], [system('s', 'stop_hook_summary')], 'RESULT'], fires: 1 },
      { name: 'an app turn whose result comes before its end marker', steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'done')], 'RESULT', [system('s', 'stop_hook_summary')]], fires: 1 },
      { name: 'an app turn whose result comes before its transcript is read', steps: () => ['OPEN', 'RESULT', [sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')]], fires: 1 },
      { name: 'an app turn watched from mid-turn', history: () => [sdk('u', 'q', OLD)], steps: () => ['OPEN-BEFORE', [answer('a', 'done'), system('s', 'stop_hook_summary')], 'RESULT'], fires: 1 },
      { name: 'a terminal turn after an app turn that ended before watching', history: () => [sdk('u', 'q', OLD), answer('a', 'done', OLD)], steps: () => ['OPEN-BEFORE', [terminal('u2', 'q2'), answer('a2', 'done 2')]], fires: 1 },
      { name: 'an app turn ending while the failed start-up read is retried', startFails: 1, steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')], 'RESULT'], fires: 1 },
      { name: 'an app turn whose result arrives during a failed start-up read', startFails: 2, steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')], 'RESULT', []], fires: 1 },
      { name: 'a terminal turn ending while the failed start-up read is retried', startFails: 1, steps: () => [[terminal('u', 'q'), answer('a', 'done')]], fires: 1 },
      { name: 'two terminal turns ending while the failed start-up read is retried', startFails: 1, steps: () => [[terminal('u', 'q'), toolUse('t'), toolResult('r', 't'), answer('a', 'one'), system('s', 'turn_duration'), terminal('u2', 'q2'), answer('a2', 'two'), system('s2', 'turn_duration')]], fires: 2 },
      { name: 'two terminal turns ending in one poll', steps: () => [[terminal('u', 'q'), apiError('e'), system('s', 'turn_duration'), queuedPrompt('u2', 'q2'), apiError('e2'), system('s2', 'turn_duration')]], fires: 2 },
      { name: 'a terminal turn after an app turn whose system entry came late', steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'done')], 'RESULT', [system('s', 'stop_hook_summary')], [terminal('u2', 'q2'), answer('a2', 'done 2')]], fires: 2 },
      { name: 'an app turn interrupted, then answered', steps: () => ['OPEN', [sdk('u', 'q'), toolUse('t'), interrupt('i')], 'RESULT', [answer('a', 'stopped')]], fires: 1 },
      { name: 'a terminal turn interrupted, then answered', steps: () => [[terminal('u', 'q'), toolUse('t'), interrupt('i')], [answer('a', 'stopped')]], fires: 1 },
      { name: 'a terminal turn interrupted during a tool', steps: () => [[terminal('u', 'q'), toolUse('t'), toolResult('r', 't', '[Request interrupted by user for tool use]'), interrupt('i')]], fires: 1 },
      { name: 'a terminal turn interrupted before any output', steps: () => [[terminal('u', 'q'), interrupt('i')], [terminal('u2', 'q2'), answer('a', 'done')]], fires: 1 },
      { name: 'an app turn that absorbed a second prompt as a queued command', steps: () => ['OPEN', [sdk('u', 'q'), toolUse('t'), toolResult('r', 't'), queued('att'), answer('a', 'both'), system('s', 'stop_hook_summary')], 'RESULT'], fires: 1 },
      { name: 'an app session turn started by a task notification', steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'started'), system('s', 'stop_hook_summary')], 'RESULT', [notification('n', 'system'), answer('a2', 'finished'), system('s2', 'stop_hook_summary')], 'RESULT'], fires: 2 },
      { name: 'a terminal session turn started by a task notification', steps: () => [[terminal('u', 'q'), answer('a', 'started')], [notification('n', 'system'), answer('a2', 'finished')]], fires: 2 },
      { name: 'an app turn waiting on a question is not a completion', steps: () => ['OPEN', [sdk('u', 'q'), toolUse('t', 'AskUserQuestion')]], fires: 0 },
      { name: 'an app turn waiting on a plan, then the approved plan\'s turn', steps: () => ['OPEN', [sdk('u', 'q'), toolUse('t', 'ExitPlanMode')], [sdk('u2', 'approved'), answer('a', 'done'), system('s', 'stop_hook_summary')], 'RESULT'], fires: 1 },
      { name: 'a terminal turn waiting on a question', steps: () => [[terminal('u', 'q'), toolUse('t', 'AskUserQuestion')]], fires: 1 },
      { name: 'a session another SDK host drives, which this adapter never prompted', steps: () => [[sdk('u', 'q'), toolUse('t'), toolResult('r', 't'), answer('a', 'done'), system('s', 'stop_hook_summary')], [notification('n', 'system'), answer('a2', 'finished'), system('s2', 'stop_hook_summary')]], fires: 2 },
      { name: 'a session another SDK host drove before the adapter took it over', steps: () => [[sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')], 'OPEN', [sdk('u2', 'q2'), answer('a2', 'done 2'), system('s2', 'stop_hook_summary')], 'RESULT'], fires: 2 },
      { name: 'a session the adapter drove before another SDK host took it over', steps: () => ['OPEN', [sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')], 'RESULT', 'CLOSE', [sdk('u2', 'q2'), answer('a2', 'done 2'), system('s2', 'stop_hook_summary')]], fires: 2 },
      { name: 'a prompt handed to a background agent over its control socket', steps: () => [[sdk('u', 'q'), answer('a', 'done'), system('s', 'stop_hook_summary')]], fires: 1 },
      { name: 'a terminal turn compacted mid-turn', steps: () => [[terminal('u', 'q'), meta('m'), toolUse('t'), toolResult('r', 't'), { ...system('c', 'compact_boundary'), parentUuid: null }, compactSummary('cs'), toolUse('t2'), toolResult('r2', 't2'), answer('a', 'done'), system('s', 'stop_hook_summary'), system('d', 'turn_duration')]], fires: 1 },
      { name: 'a terminal turn with a local command mid-turn', steps: () => [[terminal('u', 'q'), toolUse('t'), system('l', 'local_command'), toolResult('r', 't'), answer('a', 'done'), system('d', 'turn_duration')]], fires: 1 },
      { name: 'a terminal turn with a stop hook and a turn duration', steps: () => [[terminal('u', 'q'), answer('a', 'done')], [system('s', 'stop_hook_summary')], [system('d', 'turn_duration')]], fires: 1 },
      { name: 'a terminal turn whose reply is split over a thinking entry and a text entry', steps: () => [[terminal('u', 'q'), thinking('th')], [answer('a', 'done')], [system('s', 'stop_hook_summary')]], fires: 1 },
      { name: 'a terminal turn whose reply lands in one poll with its thinking', steps: () => [[terminal('u', 'q'), thinking('th'), answer('a', 'done')]], fires: 1 },
      {
        name: 'a terminal turn and an app turn interleaved',
        steps: () => [[terminal('t', 'terminal asks')], [toolUse('tt')], 'OPEN', [sdk('s', 'app asks')], [toolUse('st')],
          [from('tt', toolResult('tr', 'tt')), answer('ta', 'terminal answer'), system('ts', 'stop_hook_summary')],
          [from('st', toolResult('sr', 'st')), answer('sa', 'app answer'), system('ss', 'stop_hook_summary')], 'RESULT'],
        fires: 2,
      },
      {
        name: 'an app turn and a terminal turn interleaved',
        steps: () => ['OPEN', [sdk('s', 'app asks')], [toolUse('st')], [terminal('t', 'terminal asks')], [toolUse('tt')],
          [from('st', toolResult('sr', 'st')), answer('sa', 'app answer'), system('ss', 'stop_hook_summary')], 'RESULT',
          [from('tt', toolResult('tr', 'tt')), answer('ta', 'terminal answer'), system('ts', 'stop_hook_summary')]],
        fires: 2,
      },
      ...Object.entries(markerless).flatMap(([how, turn1]) => [
        { name: `an app turn ${how}, then a turn from the app`, startFails: 1, steps: () => ['OPEN' as const, turn1(sdk('u1', 'run it')), 'RESULT' as const, [sdk('u2', 'next'), answer('a2', 'answer 2')], 'RESULT' as const], fires: 2 },
        { name: `an app turn ${how}, then a turn from the terminal`, startFails: 1, steps: () => ['OPEN' as const, turn1(sdk('u1', 'run it')), 'RESULT' as const, [terminal('u2', 'next'), answer('a2', 'answer 2')]], fires: 2 },
      ]),
    ];

    const run = ({ history, startFails, steps, fires }: Case) => {
      clock = Date.now();
      prev = undefined;
      span = null;
      fs.writeFileSync(file, line('old-1', 'old question') + agent('a-old', 'old answer') + J(history?.() ?? []));
      const completions: CompletionEvent[] = [];
      const watcher = new SessionWatcher(() => {}, (c) => completions.push(c), (_sessionId, at) => hadQuery(at));
      if (startFails) restore.push(failOnce(undefined, undefined, startFails)());
      watcher.watchSession('s', file);
      const w = internals(watcher);
      const session = () => w.watchedSessions.get('s');
      for (const step of steps()) {
        if (step === 'OPEN') span = { from: clock };
        else if (step === 'OPEN-BEFORE') span = { from: 0 };
        else if (step === 'CLOSE') span = { ...span!, to: clock };
        else if (step === 'RESULT') expect(watcher.announceTurn('s')).toBe(true);
        else { fs.appendFileSync(file, J(step)); w.checkSession(session()); }
      }
      w.checkSession(session());
      w.checkSession(session());
      watcher.unwatchAll();
      expect(completions).toHaveLength(fires);
      return completions;
    };

    it.each(cases)('announces $name once', (c) => {
      const completions = run(c);
      if (c.name.includes('split over a thinking entry') || c.name.includes('with its thinking')) expect(completions[0].lastMessage).toBe('done');
    });

    it('counts every user and assistant entry, and only those, as a message', () => {
      const completions = run({ name: '', history: () => [toolUse('t0'), toolResult('r0', 't0')],
        steps: () => [[terminal('u', 'q'), toolUse('t'), toolResult('r', 't'), queued('att'), system('l', 'local_command'), answer('a', 'done'), system('d', 'turn_duration')]], fires: 1 });
      const inFile = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l).type).filter((t) => t === 'user' || t === 'assistant');
      expect(inFile).toHaveLength(8);
      expect(completions[0]).toMatchObject({ messageCount: 8, lastMessage: 'done' });
    });

    // Real transcripts, when this machine has them: a worker session driven by another SDK
    // host, and a terminal turn that was auto-compacted mid-turn.
    const real = (project: string, id: string, first: number, last: number) => {
      const p = path.join(os.homedir(), '.claude/projects', project, `${id}.jsonl`);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8').split('\n').slice(first - 1, last).map((l) => l + '\n') : null;
    };
    const slices = [
      { name: 'a foreign SDK host\'s turn and the task notification turn after it', lines: real('-Users-mrwoof-src-cmdctrl-worktrees-daemon-relay', 'a82df0ae-5d60-4ce6-b3c3-b4a1c67e15c9', 3647, 3914), fires: 2 },
      { name: 'a terminal turn auto-compacted mid-turn', lines: real('-Users-mrwoof-src-cmdctrl', 'b4290f25-d3c7-473a-b380-7b3b8fcf3ede', 253, 826), fires: 1 },
    ];
    for (const { name, lines, fires } of slices) {
      (lines ? it : it.skip)(`announces ${name} once, from a real transcript`, () => {
        fs.writeFileSync(file, line('old-1', 'old question') + agent('a-old', 'old answer'));
        let count = 0;
        const watcher = new SessionWatcher(() => {}, () => { count++; });
        watcher.watchSession('s', file);
        const w = internals(watcher);
        for (const l of lines!) { fs.appendFileSync(file, l); w.checkSession(w.watchedSessions.get('s')); }
        watcher.unwatchAll();
        expect(count).toBe(fires);
      });
    }
  });
});
