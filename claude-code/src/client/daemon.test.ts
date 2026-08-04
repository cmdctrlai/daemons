/**
 * Tests for the wiring between the SDK client and Claude Code's own
 * machinery: which outbound message each internal event produces, and when
 * a session file starts being watched.
 */

type Handler = (...args: any[]) => any;

// Captured from the mocked SDK client so tests can invoke the handlers the
// daemon registered, as the server would.
const handlers: Record<string, Handler> = {};
const sent: Array<Record<string, unknown>> = [];
let clientOptions: Record<string, any> = {};

jest.mock('@cmdctrl/daemon-sdk', () => ({
  isAutoUpdateSupported: () => true,
  ConfigManager: class {
    configDir = '/tmp/cmdctrl-claude-code-test';
    configFile = '/tmp/cmdctrl-claude-code-test/config.json';
    credentialsFile = '/tmp/cmdctrl-claude-code-test/credentials';
    pidFile = '/tmp/cmdctrl-claude-code-test/daemon.pid';
    deletePidFile() {}
  },
  DaemonClient: class {
    constructor(options: Record<string, unknown>) {
      clientOptions = options;
    }
    sendEvent(taskId: string, eventType: string, data: Record<string, unknown>) {
      sent.push({ type: 'event', task_id: taskId, event_type: eventType, ...data });
    }
    sendSessionActivity(
      sessionId: string,
      filePath: string,
      lastMessage: string,
      messageCount: number,
      isCompletion: boolean,
    ) {
      sent.push({
        type: 'session_activity',
        session_id: sessionId,
        file_path: filePath,
        last_message: lastMessage,
        message_count: messageCount,
        is_completion: isCompletion,
      });
    }
    setRunningTasksProvider(p: Handler) { handlers.runningTasks = p; return this; }
    setSessionsProvider(p: Handler) { handlers.sessions = p; return this; }
    onTaskStart(h: Handler) { handlers.taskStart = h; return this; }
    onTaskResume(h: Handler) { handlers.taskResume = h; return this; }
    onTaskCancel(h: Handler) { handlers.taskCancel = h; return this; }
    onGetMessages(h: Handler) { handlers.getMessages = h; return this; }
    onWatchSession(h: Handler) { handlers.watchSession = h; return this; }
    onUnwatchSession(h: Handler) { handlers.unwatchSession = h; return this; }
    onContextRequest(h: Handler) { handlers.contextRequest = h; return this; }
    disconnect() { return Promise.resolve(); }
  },
}));

const adapter = {
  onEvent: undefined as Handler | undefined,
  startTask: jest.fn(),
  resumeTask: jest.fn(),
  cancelTask: jest.fn(),
  stopAll: jest.fn(),
  getRunningTasks: jest.fn(() => ['task-1']),
};

const watcher = {
  onEvent: undefined as Handler | undefined,
  onCompletion: undefined as Handler | undefined,
  watchSession: jest.fn(),
  unwatchSession: jest.fn(),
  unwatchAll: jest.fn(),
  reserveCompletionFire: jest.fn((_sessionId: string) => true),
};

jest.mock('../adapter/claude-cli', () => ({
  ClaudeAdapter: class {
    constructor(onEvent: Handler) {
      adapter.onEvent = onEvent;
    }
    startTask(...args: unknown[]) { return adapter.startTask(...args); }
    resumeTask(...args: unknown[]) { return adapter.resumeTask(...args); }
    cancelTask(...args: unknown[]) { return adapter.cancelTask(...args); }
    stopAll() { return adapter.stopAll(); }
    getRunningTasks() { return adapter.getRunningTasks(); }
  },
}));

jest.mock('../session-watcher', () => ({
  SessionWatcher: class {
    constructor(onEvent: Handler, onCompletion: Handler) {
      watcher.onEvent = onEvent;
      watcher.onCompletion = onCompletion;
    }
    watchSession(...args: unknown[]) { return watcher.watchSession(...args); }
    unwatchSession(...args: unknown[]) { return watcher.unwatchSession(...args); }
    unwatchAll() { return watcher.unwatchAll(); }
    reserveCompletionFire(sessionId: string) { return watcher.reserveCompletionFire(sessionId); }
  },
}));

jest.mock('../message-reader', () => ({
  findSessionFile: jest.fn(),
  readMessages: jest.fn(),
}));

jest.mock('../session-discovery', () => ({ discoverSessions: jest.fn() }));

jest.mock('../handlers/context-handler', () => ({ extractSessionContext: jest.fn() }));

import { createDaemon } from './daemon';
import { findSessionFile, readMessages } from '../message-reader';
import { discoverSessions } from '../session-discovery';
import { extractSessionContext } from '../handlers/context-handler';

const mockFindSessionFile = findSessionFile as jest.Mock;
const mockReadMessages = readMessages as jest.Mock;
const mockDiscoverSessions = discoverSessions as jest.Mock;
const mockExtractContext = extractSessionContext as jest.Mock;

const config = { serverUrl: 'http://localhost:4000', deviceId: 'dev-1', deviceName: 'Test' };
const credentials = { refreshToken: 'rt-1' };

function build() {
  return createDaemon(config, credentials);
}

beforeEach(() => {
  jest.clearAllMocks();
  sent.length = 0;
  watcher.reserveCompletionFire.mockReturnValue(true);
  adapter.getRunningTasks.mockReturnValue(['task-1']);
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('client configuration', () => {
  test('identifies as claude_code and logs protocol frames', () => {
    build();
    expect(clientOptions.agentType).toBe('claude_code');
    expect(clientOptions.logFrames).toBe(true);
    expect(clientOptions.autoUpdate).toBe(true);
    expect(clientOptions.autoUpdateConfig.packageName).toBe('@cmdctrl/claude-code');
  });

  test('the adapter owns the running-task set', () => {
    build();
    adapter.getRunningTasks.mockReturnValue(['a', 'b']);
    expect(handlers.runningTasks()).toEqual(['a', 'b']);
  });
});

describe('adapter events', () => {
  test('forwards the event verbatim', () => {
    build();
    mockFindSessionFile.mockReturnValue('/tmp/s.jsonl');

    adapter.onEvent!('task-1', 'PROGRESS', { action: 'Reading', target: 'file.ts' });

    expect(sent).toEqual([{
      type: 'event',
      task_id: 'task-1',
      event_type: 'PROGRESS',
      action: 'Reading',
      target: 'file.ts',
    }]);
  });

  const watchCases: Array<{ name: string; eventType: string; sessionId?: string; filePath: string | null; watched: boolean }> = [
    { name: 'watches as soon as a session id appears', eventType: 'SESSION_STARTED', sessionId: 's1', filePath: '/tmp/s1.jsonl', watched: true },
    { name: 'watches on any event carrying a session id', eventType: 'TASK_COMPLETE', sessionId: 's1', filePath: '/tmp/s1.jsonl', watched: true },
    { name: 'does not watch without a session id', eventType: 'PROGRESS', sessionId: undefined, filePath: '/tmp/s1.jsonl', watched: false },
    { name: 'does not watch a session with no file yet', eventType: 'TASK_COMPLETE', sessionId: 's1', filePath: null, watched: false },
  ];

  test.each(watchCases)('$name', ({ eventType, sessionId, filePath, watched }) => {
    build();
    mockFindSessionFile.mockReturnValue(filePath);
    watcher.reserveCompletionFire.mockReturnValue(false);

    adapter.onEvent!('task-1', eventType, sessionId ? { session_id: sessionId } : {});

    expect(watcher.watchSession).toHaveBeenCalledTimes(watched ? 1 : 0);
    if (watched) {
      expect(watcher.watchSession).toHaveBeenCalledWith(sessionId, filePath);
    }
  });

  test('retries watching until the session file exists', () => {
    jest.useFakeTimers();
    build();
    mockFindSessionFile.mockReturnValue(null);

    adapter.onEvent!('task-1', 'SESSION_STARTED', { session_id: 's1' });
    expect(watcher.watchSession).not.toHaveBeenCalled();

    mockFindSessionFile.mockReturnValue('/tmp/s1.jsonl');
    jest.advanceTimersByTime(500);

    expect(watcher.watchSession).toHaveBeenCalledWith('s1', '/tmp/s1.jsonl');
    jest.useRealTimers();
  });

  test('gives up watching after the retry ladder is exhausted', () => {
    jest.useFakeTimers();
    build();
    mockFindSessionFile.mockReturnValue(null);

    adapter.onEvent!('task-1', 'SESSION_STARTED', { session_id: 's1' });
    jest.advanceTimersByTime(60000);

    expect(watcher.watchSession).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});

describe('backup completion', () => {
  const cases: Array<{ name: string; reserved: boolean; filePath: string | null; fires: boolean }> = [
    { name: 'fires when the watcher has not already sent one', reserved: true, filePath: '/tmp/s1.jsonl', fires: true },
    { name: 'stays quiet when the watcher already fired', reserved: false, filePath: '/tmp/s1.jsonl', fires: false },
    { name: 'stays quiet when the session file is gone', reserved: true, filePath: null, fires: false },
  ];

  test.each(cases)('$name', ({ reserved, filePath, fires }) => {
    build();
    mockFindSessionFile.mockReturnValue(filePath);
    watcher.reserveCompletionFire.mockReturnValue(reserved);

    adapter.onEvent!('task-1', 'TASK_COMPLETE', { session_id: 's1', result: 'all done' });

    const activity = sent.filter((m) => m.type === 'session_activity');
    expect(activity).toHaveLength(fires ? 1 : 0);
    if (fires) {
      expect(activity[0]).toEqual({
        type: 'session_activity',
        session_id: 's1',
        file_path: '/tmp/s1.jsonl',
        last_message: 'all done',
        message_count: 0,
        is_completion: true,
      });
    }
  });

  test('only completions trigger the backup', () => {
    build();
    mockFindSessionFile.mockReturnValue('/tmp/s1.jsonl');

    adapter.onEvent!('task-1', 'WAIT_FOR_USER', { session_id: 's1', prompt: 'Which one?' });

    expect(sent.filter((m) => m.type === 'session_activity')).toHaveLength(0);
  });
});

describe('session watcher events', () => {
  test('sends watched-session entries as task-less events', () => {
    build();
    mockFindSessionFile.mockReturnValue('/tmp/s1.jsonl');

    watcher.onEvent!({
      type: 'AGENT_RESPONSE',
      sessionId: 's1',
      uuid: 'u1',
      content: 'Hello',
      timestamp: '2026-08-02T00:00:00Z',
    });

    expect(sent).toEqual([{
      type: 'event',
      task_id: '',
      event_type: 'AGENT_RESPONSE',
      session_id: 's1',
      uuid: 'u1',
      content: 'Hello',
      timestamp: '2026-08-02T00:00:00Z',
    }]);
  });

  test('sends completions as session activity', () => {
    build();

    watcher.onCompletion!({
      sessionId: 's1',
      filePath: '/tmp/s1.jsonl',
      lastMessage: 'Done',
      messageCount: 12,
    });

    expect(sent).toEqual([{
      type: 'session_activity',
      session_id: 's1',
      file_path: '/tmp/s1.jsonl',
      last_message: 'Done',
      message_count: 12,
      is_completion: true,
    }]);
  });
});

describe('server requests', () => {
  test('task_start passes images and project path to the adapter', async () => {
    build();
    await handlers.taskStart({
      taskId: 't1', instruction: 'do it', projectPath: '/tmp/p', images: ['data:image/png;base64,AA'],
    });
    expect(adapter.startTask).toHaveBeenCalledWith('t1', 'do it', '/tmp/p', ['data:image/png;base64,AA']);
  });

  test('task_resume passes images and project path to the adapter', async () => {
    build();
    await handlers.taskResume({
      taskId: 't1', sessionId: 's1', message: 'more', projectPath: '/tmp/p', images: ['data:image/png;base64,AA'],
    });
    expect(adapter.resumeTask).toHaveBeenCalledWith('t1', 's1', 'more', '/tmp/p', ['data:image/png;base64,AA']);
  });

  test('a failed task start is reported as an error', async () => {
    build();
    adapter.startTask.mockRejectedValueOnce(new Error('spawn failed'));
    const error = jest.fn();

    await handlers.taskStart({ taskId: 't1', instruction: 'do it', error });

    expect(error).toHaveBeenCalledWith('spawn failed');
  });

  test('get_messages returns the reader result', () => {
    build();
    mockReadMessages.mockReturnValue({ messages: [{ uuid: 'u1' }], hasMore: true, oldestUuid: 'u1', newestUuid: 'u1' });

    const result = handlers.getMessages({ sessionId: 's1', limit: 50, beforeUuid: 'u9' });

    expect(mockReadMessages).toHaveBeenCalledWith('s1', 50, 'u9', undefined);
    expect(result).toEqual({ messages: [{ uuid: 'u1' }], hasMore: true, oldestUuid: 'u1', newestUuid: 'u1' });
  });

  test('watch/unwatch drive the session watcher', () => {
    build();
    handlers.watchSession('s1', '/tmp/s1.jsonl');
    handlers.unwatchSession('s1');
    expect(watcher.watchSession).toHaveBeenCalledWith('s1', '/tmp/s1.jsonl');
    expect(watcher.unwatchSession).toHaveBeenCalledWith('s1');
  });

  test('report_sessions passes discovery through untouched', async () => {
    build();
    const sessions = [{ session_id: 's1', cli_user_title: 'Renamed in the CLI' }];
    mockDiscoverSessions.mockResolvedValue(sessions);
    await expect(handlers.sessions()).resolves.toBe(sessions);
  });
});

describe('context requests', () => {
  test('returns the extracted context', () => {
    build();
    const context = {
      title: 'Session', projectPath: '/tmp/p', messageCount: 3,
      lastActivityAt: '2026-08-02T00:00:00Z', status: 'working',
    };
    mockExtractContext.mockReturnValue(context);

    expect(handlers.contextRequest({ sessionId: 's1', recentMessagesCount: 3 })).toBe(context);
    expect(mockExtractContext).toHaveBeenCalledWith('s1', {
      includeInitialPrompt: undefined,
      recentMessagesCount: 3,
      includeLastToolUse: undefined,
    });
  });

  test('answers a missing session with an error envelope rather than silence', () => {
    build();
    mockExtractContext.mockReturnValue(null);

    const response = handlers.contextRequest({ sessionId: 's1' });

    expect(response).toEqual(expect.objectContaining({
      title: '',
      projectPath: '',
      messageCount: 0,
      status: 'stale',
      error: 'Session s1 not found',
    }));
  });
});

describe('shutdown', () => {
  test('stops tasks and watchers before closing the connection', async () => {
    const daemon = build();
    await daemon.shutdown();
    expect(adapter.stopAll).toHaveBeenCalled();
    expect(watcher.unwatchAll).toHaveBeenCalled();
  });
});
