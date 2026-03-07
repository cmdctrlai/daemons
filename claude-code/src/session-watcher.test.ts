/**
 * Tests for SessionWatcher file change detection
 *
 * This test verifies that the SessionWatcher reliably detects
 * file changes when an external process appends to a JSONL file
 * (simulating Claude CLI writing to session files).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import { SessionWatcher, SessionEvent } from './session-watcher';

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
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
