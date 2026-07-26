import { EventEmitter } from 'events';

// Must be declared before jest.mock since the factory is hoisted
let mockWsInstance: any;

// Governs how each newly constructed MockWS behaves on the next tick, so
// tests can simulate a connect failure before the client's 'open' handler
// would otherwise fire. Reset between tests.
let nextConnectOutcome: 'open' | { unexpectedResponse: number } | 'hang' = 'open';
// Counts every MockWS construction, i.e. every connection attempt made by
// the client (initial + every reconnect). Reset between tests.
let connectAttemptCount = 0;

jest.mock('ws', () => {
  const { EventEmitter: EE } = require('events');

  class MockWS extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1; // OPEN
    sentMessages: any[] = [];

    constructor(_url: string, _opts?: any) {
      super();
      mockWsInstance = this;
      connectAttemptCount++;
      const outcome = nextConnectOutcome;
      if (outcome === 'hang') return;
      setTimeout(() => {
        if (outcome === 'open') {
          this.emit('open');
        } else {
          this.readyState = 0; // CONNECTING – matches real ws behavior on a rejected upgrade
          this.emit('unexpected-response', { destroy: () => {} }, { statusCode: outcome.unexpectedResponse });
        }
      }, 0);
    }

    send(data: string) { this.sentMessages.push(JSON.parse(data)); }
    ping() {}
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.readyState = 3; }
  }

  return { __esModule: true, default: MockWS };
});

import { DaemonClient } from '../client';

function createClient(overrides: Record<string, any> = {}): DaemonClient {
  return new DaemonClient({
    serverUrl: 'https://app.cmd-ctrl.ai',
    deviceId: 'dev-1',
    agentType: 'test_agent',
    token: 'rt-test',
    version: '1.0.0',
    ...overrides,
  });
}

function simulateMessage(msg: Record<string, unknown>) {
  mockWsInstance.emit('message', JSON.stringify(msg));
}

describe('DaemonClient', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    nextConnectOutcome = 'open';
    connectAttemptCount = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('ping/pong', () => {
    test('responds to ping with pong', async () => {
      const client = createClient();
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'ping' });
      await jest.advanceTimersByTimeAsync(0);

      const pong = mockWsInstance.sentMessages.find((m: any) => m.type === 'pong');
      expect(pong).toEqual({ type: 'pong' });
      await client.disconnect();
    });
  });

  describe('task_start', () => {
    test('calls handler and tracks running task', async () => {
      const client = createClient();
      const started: string[] = [];

      client.onTaskStart(async (task) => {
        started.push(task.taskId);
        task.sessionStarted('native-1');
        task.complete('done');
      });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      expect(started).toEqual(['t1']);

      const events = mockWsInstance.sentMessages.filter((m: any) => m.type === 'event');
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ event_type: 'SESSION_STARTED', session_id: 'native-1' }),
          expect.objectContaining({ event_type: 'TASK_COMPLETE', result: 'done' }),
        ])
      );
      await client.disconnect();
    });

    test('sends ERROR event when handler throws', async () => {
      const client = createClient();
      client.onTaskStart(async () => { throw new Error('handler crashed'); });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      const errorEvent = mockWsInstance.sentMessages.find(
        (m: any) => m.type === 'event' && m.event_type === 'ERROR'
      );
      expect(errorEvent).toEqual(expect.objectContaining({
        task_id: 't1',
        event_type: 'ERROR',
        error: 'handler crashed',
      }));
      await client.disconnect();
    });

    test('does nothing without a handler', async () => {
      const client = createClient();
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      const msgsBefore = mockWsInstance.sentMessages.length;
      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      const newEvents = mockWsInstance.sentMessages.slice(msgsBefore).filter((m: any) => m.type === 'event');
      expect(newEvents).toHaveLength(0);
      await client.disconnect();
    });
  });

  describe('task_resume', () => {
    test('calls handler with correct resume handle', async () => {
      const client = createClient();
      const resumed: Array<{ taskId: string; sessionId: string; message: string }> = [];

      client.onTaskResume(async (task) => {
        resumed.push({ taskId: task.taskId, sessionId: task.sessionId, message: task.message });
        task.complete('resumed-done');
      });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_resume', task_id: 't1', session_id: 's1', message: 'follow up' });
      await jest.advanceTimersByTimeAsync(0);

      expect(resumed).toEqual([{ taskId: 't1', sessionId: 's1', message: 'follow up' }]);
      await client.disconnect();
    });
  });

  describe('task_cancel', () => {
    test('removes task from running and calls handler', async () => {
      const client = createClient();
      const cancelled: string[] = [];

      client.onTaskStart(async (task) => {
        task.sessionStarted('s1');
        await new Promise(() => {}); // hang forever
      });
      client.onTaskCancel((taskId) => cancelled.push(taskId));

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      simulateMessage({ type: 'task_cancel', task_id: 't1' });
      await jest.advanceTimersByTimeAsync(0);

      expect(cancelled).toEqual(['t1']);

      const statuses = mockWsInstance.sentMessages.filter((m: any) => m.type === 'status');
      const lastStatus = statuses[statuses.length - 1];
      expect(lastStatus.running_tasks).not.toContain('t1');
      await client.disconnect();
    });
  });

  describe('get_messages', () => {
    test('routes request and sends response back', async () => {
      const client = createClient();
      client.onGetMessages(() => ({
        messages: [{ uuid: 'u1', role: 'USER', content: 'hello', timestamp: '2026-01-01T00:00:00Z' }],
        hasMore: false,
        oldestUuid: 'u1',
      }));

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'get_messages', request_id: 'r1', session_id: 's1', limit: 50 });
      await jest.advanceTimersByTimeAsync(0);

      const response = mockWsInstance.sentMessages.find((m: any) => m.type === 'messages');
      expect(response).toEqual(expect.objectContaining({
        type: 'messages',
        request_id: 'r1',
        session_id: 's1',
        has_more: false,
        oldest_uuid: 'u1',
      }));
      expect(response.messages).toHaveLength(1);
      await client.disconnect();
    });

    test('sends error response when handler throws', async () => {
      const client = createClient();
      client.onGetMessages(() => { throw new Error('db down'); });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'get_messages', request_id: 'r1', session_id: 's1', limit: 50 });
      await jest.advanceTimersByTimeAsync(0);

      const response = mockWsInstance.sentMessages.find((m: any) => m.type === 'messages');
      expect(response).toEqual(expect.objectContaining({
        request_id: 'r1',
        error: 'db down',
        messages: [],
        has_more: false,
      }));
      await client.disconnect();
    });
  });

  describe('watch/unwatch session', () => {
    test('routes watch and unwatch to handlers', async () => {
      const client = createClient();
      const watched: Array<{ id: string; path: string }> = [];
      const unwatched: string[] = [];

      client.onWatchSession((id, filePath) => watched.push({ id, path: filePath }));
      client.onUnwatchSession((id) => unwatched.push(id));

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'watch_session', session_id: 's1', file_path: '/tmp/s.jsonl' });
      simulateMessage({ type: 'unwatch_session', session_id: 's1' });
      await jest.advanceTimersByTimeAsync(0);

      expect(watched).toEqual([{ id: 's1', path: '/tmp/s.jsonl' }]);
      expect(unwatched).toEqual(['s1']);
      await client.disconnect();
    });
  });

  describe('version_status', () => {
    test('update_required disconnects client', async () => {
      const client = createClient();
      const statuses: string[] = [];
      client.onVersionStatus((msg) => statuses.push(msg.status));

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'version_status', status: 'update_required', your_version: '0.1.0', min_version: '1.0.0' });
      await jest.advanceTimersByTimeAsync(0);

      expect(statuses).toEqual(['update_required']);
      expect(mockWsInstance.readyState).toBe(3); // CLOSED
    });

    test('update_available does not disconnect', async () => {
      const client = createClient();

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'version_status', status: 'update_available', your_version: '0.9.0' });
      await jest.advanceTimersByTimeAsync(0);

      expect(mockWsInstance.readyState).toBe(1); // OPEN
      await client.disconnect();
    });
  });

  describe('context_request', () => {
    test('routes context request and sends response', async () => {
      const client = createClient();
      client.onContextRequest(() => ({
        title: 'Test Session',
        projectPath: '/tmp/project',
        messageCount: 5,
        lastActivityAt: '2026-01-01T00:00:00Z',
        status: 'working' as const,
      }));

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({
        type: 'context_request', request_id: 'r1', session_id: 's1',
        include: { initial_prompt: true, recent_messages: 3 },
      });
      await jest.advanceTimersByTimeAsync(0);

      const response = mockWsInstance.sentMessages.find((m: any) => m.type === 'context_response');
      expect(response).toEqual(expect.objectContaining({
        type: 'context_response', request_id: 'r1', session_id: 's1',
      }));
      expect(response.context.title).toBe('Test Session');
      await client.disconnect();
    });
  });

  describe('sendSessionActivity', () => {
    test('sends correctly shaped message', async () => {
      const client = createClient();
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      client.sendSessionActivity('s1', '/tmp/s.jsonl', 'last msg', 10, true, '2026-01-01T00:00:00Z', 'uuid-1');

      const activity = mockWsInstance.sentMessages.find((m: any) => m.type === 'session_activity');
      expect(activity).toEqual({
        type: 'session_activity',
        session_id: 's1',
        file_path: '/tmp/s.jsonl',
        last_message: 'last msg',
        message_count: 10,
        is_completion: true,
        last_activity: '2026-01-01T00:00:00Z',
        user_message_uuid: 'uuid-1',
      });
      await client.disconnect();
    });
  });

  describe('reportSessions', () => {
    test('sends empty sessions without provider', async () => {
      const client = createClient();
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      const report = mockWsInstance.sentMessages.find((m: any) => m.type === 'report_sessions');
      expect(report).toEqual({ type: 'report_sessions', sessions: [] });
      await client.disconnect();
    });

    test('sends sessions from provider', async () => {
      const client = createClient();
      const sessions = [{
        session_id: 's1', slug: 'test', title: 'Test', project: '/tmp',
        project_name: 'proj', file_path: '/tmp/s.jsonl', last_message: 'hi',
        last_activity: '2026-01-01T00:00:00Z', is_active: true, message_count: 1,
      }];
      client.setSessionsProvider(() => sessions);

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      const report = mockWsInstance.sentMessages.find((m: any) => m.type === 'report_sessions');
      expect(report?.sessions).toEqual(sessions);
      await client.disconnect();
    });
  });

  describe('task handle methods', () => {
    test('progress sends PROGRESS event', async () => {
      const client = createClient();
      client.onTaskStart(async (task) => {
        task.progress('Reading', 'file.ts');
        task.complete('done');
      });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      const progress = mockWsInstance.sentMessages.find(
        (m: any) => m.type === 'event' && m.event_type === 'PROGRESS'
      );
      expect(progress).toEqual(expect.objectContaining({
        task_id: 't1', action: 'Reading', target: 'file.ts',
      }));
      await client.disconnect();
    });

    test('output sends OUTPUT event', async () => {
      const client = createClient();
      client.onTaskStart(async (task) => {
        task.output('verbose text', 'uuid-1');
        task.complete('done');
      });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      const output = mockWsInstance.sentMessages.find(
        (m: any) => m.type === 'event' && m.event_type === 'OUTPUT'
      );
      expect(output).toEqual(expect.objectContaining({
        task_id: 't1', output: 'verbose text', user_message_uuid: 'uuid-1',
      }));
      await client.disconnect();
    });

    test('waitForUser sends WAIT_FOR_USER and removes from running', async () => {
      const client = createClient();
      client.onTaskStart(async (task) => {
        task.sessionStarted('s1');
        task.waitForUser('Need input', 'partial', [{ label: 'Yes' }, { label: 'No' }]);
      });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      const waitEvent = mockWsInstance.sentMessages.find(
        (m: any) => m.type === 'event' && m.event_type === 'WAIT_FOR_USER'
      );
      expect(waitEvent).toEqual(expect.objectContaining({
        task_id: 't1', prompt: 'Need input', result: 'partial',
        options: [{ label: 'Yes' }, { label: 'No' }],
      }));

      const statuses = mockWsInstance.sentMessages.filter((m: any) => m.type === 'status');
      const lastStatus = statuses[statuses.length - 1];
      expect(lastStatus.running_tasks).not.toContain('t1');
      await client.disconnect();
    });

    test('error sends ERROR event and removes from running', async () => {
      const client = createClient();
      client.onTaskStart(async (task) => { task.error('something broke'); });

      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      simulateMessage({ type: 'task_start', task_id: 't1', instruction: 'test' });
      await jest.advanceTimersByTimeAsync(0);

      const errorEvent = mockWsInstance.sentMessages.find(
        (m: any) => m.type === 'event' && m.event_type === 'ERROR'
      );
      expect(errorEvent).toEqual(expect.objectContaining({
        task_id: 't1', error: 'something broke',
      }));
      await client.disconnect();
    });
  });

  describe('invalid JSON', () => {
    test('silently ignores unparseable messages', async () => {
      const client = createClient();
      const p = client.connect();
      await jest.advanceTimersByTimeAsync(0);
      await p;

      const msgsBefore = mockWsInstance.sentMessages.length;
      mockWsInstance.emit('message', 'not json at all');
      await jest.advanceTimersByTimeAsync(0);

      const newEvents = mockWsInstance.sentMessages.slice(msgsBefore).filter((m: any) => m.type === 'event');
      expect(newEvents).toHaveLength(0);
      await client.disconnect();
    });
  });

  describe('reconnect backoff', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    // The mock WS schedules its own 0ms timer to emit its outcome, and the
    // fake-timer runtime schedules its own housekeeping timers too – filter
    // both out and keep only the real reconnect-scheduling delay.
    function lastReconnectDelay(spy: jest.SpyInstance): number {
      const real = spy.mock.calls.filter((call) => (call[1] as number) > 0);
      return real[real.length - 1][1] as number;
    }

    test.each([
      { failures: 1, expectedDelay: 500 },    // 0.5 * min(60000, 1000 * 2^0)
      { failures: 2, expectedDelay: 1000 },   // 0.5 * 2000
      { failures: 3, expectedDelay: 2000 },   // 0.5 * 4000
      { failures: 5, expectedDelay: 8000 },   // 0.5 * 16000
      { failures: 7, expectedDelay: 30000 },  // 0.5 * min(60000, 64000)
      { failures: 8, expectedDelay: 30000 },  // stays capped past the cap tier
    ])('delay after $failures consecutive failures is capped exponential with jitter ($expectedDelay ms)', async ({ failures, expectedDelay }) => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      nextConnectOutcome = { unexpectedResponse: 500 };
      const client = createClient({ baseReconnectDelay: 1000, maxReconnectDelay: 60000 });
      client.connect().catch(() => {});

      let lastDelay = 0;
      for (let i = 0; i < failures; i++) {
        setTimeoutSpy.mockClear();
        await jest.advanceTimersByTimeAsync(lastDelay);
        // The reconnect timer firing creates a new MockWS, which schedules
        // its own 0ms timer to emit its outcome – give that a tick to run.
        await jest.advanceTimersByTimeAsync(1);
        lastDelay = lastReconnectDelay(setTimeoutSpy);
      }

      expect(lastDelay).toBe(expectedDelay);
      await client.disconnect();
    });

    test('retries are unbounded – no cap on the number of reconnect attempts', async () => {
      nextConnectOutcome = { unexpectedResponse: 500 };
      const client = createClient();
      client.connect().catch(() => {});

      for (let i = 0; i < 20; i++) {
        await jest.advanceTimersByTimeAsync(60000);
      }

      expect(connectAttemptCount).toBeGreaterThan(15);
      await client.disconnect();
    });

    test('a successful connection resets the backoff sequence', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5);
      const setTimeoutSpy = jest.spyOn(global, 'setTimeout');

      nextConnectOutcome = { unexpectedResponse: 500 };
      const client = createClient({ baseReconnectDelay: 1000, maxReconnectDelay: 60000 });
      client.connect().catch(() => {});

      // Drive three failures so the backoff has grown past the base delay.
      let lastDelay = 0;
      for (let i = 0; i < 3; i++) {
        setTimeoutSpy.mockClear();
        await jest.advanceTimersByTimeAsync(lastDelay);
        await jest.advanceTimersByTimeAsync(1);
        lastDelay = lastReconnectDelay(setTimeoutSpy);
      }
      expect(lastDelay).toBeGreaterThan(500);

      // Let the next attempt succeed, then fail again – backoff should restart at the base tier.
      nextConnectOutcome = 'open';
      await jest.advanceTimersByTimeAsync(lastDelay);
      await jest.advanceTimersByTimeAsync(0);

      setTimeoutSpy.mockClear();
      nextConnectOutcome = { unexpectedResponse: 500 };
      mockWsInstance.emit('close');
      const resetDelay = lastReconnectDelay(setTimeoutSpy);

      expect(resetDelay).toBe(500); // back to attempt-0 tier: 0.5 * 1000
      await client.disconnect();
    });
  });

  describe('auth failure handling (401)', () => {
    test('never gives up on repeated 401s – keeps retrying and notifies once past the warn threshold', async () => {
      nextConnectOutcome = { unexpectedResponse: 401 };
      let authFailureCalls = 0;
      const client = createClient();
      client.onAuthFailure(() => { authFailureCalls++; });

      client.connect().catch(() => {});
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(60000);
      }

      expect(connectAttemptCount).toBeGreaterThan(9); // no give-up threshold
      expect(authFailureCalls).toBe(1); // advisory notice fires once, not on every failure
      await client.disconnect();
    });

    test('a later successful connection re-arms the notification for a future run of failures', async () => {
      nextConnectOutcome = { unexpectedResponse: 401 };
      let authFailureCalls = 0;
      const client = createClient();
      client.onAuthFailure(() => { authFailureCalls++; });

      client.connect().catch(() => {});
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(60000);
      }
      expect(authFailureCalls).toBe(1);

      nextConnectOutcome = 'open';
      await jest.advanceTimersByTimeAsync(60000);
      await jest.advanceTimersByTimeAsync(0);

      nextConnectOutcome = { unexpectedResponse: 401 };
      mockWsInstance.emit('close');
      for (let i = 0; i < 10; i++) {
        await jest.advanceTimersByTimeAsync(60000);
      }

      expect(authFailureCalls).toBe(2);
      await client.disconnect();
    });
  });
});
