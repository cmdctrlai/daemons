import type {
  ServerMessage,
  DaemonMessage,
  PingMessage,
  TaskStartMessage,
  TaskResumeMessage,
  TaskCancelMessage,
  GetMessagesMessage,
  WatchSessionMessage,
  UnwatchSessionMessage,
  ContextRequestMessage,
  VersionStatusMessage,
  PongMessage,
  StatusMessage,
  EventMessage,
  ReportSessionsMessage,
  MessagesResponseMessage,
  SessionActivityMessage,
  ContextResponseMessage,
  SessionInfo,
  MessageEntry,
  SessionStatus,
  EventType,
} from '../messages';

describe('message types', () => {
  describe('ServerMessage variants', () => {
    const cases: Array<{ name: string; msg: ServerMessage }> = [
      {
        name: 'ping',
        msg: { type: 'ping' } as PingMessage,
      },
      {
        name: 'task_start',
        msg: { type: 'task_start', task_id: 't1', instruction: 'do stuff' } as TaskStartMessage,
      },
      {
        name: 'task_resume',
        msg: { type: 'task_resume', task_id: 't1', session_id: 's1', message: 'continue' } as TaskResumeMessage,
      },
      {
        name: 'task_cancel',
        msg: { type: 'task_cancel', task_id: 't1' } as TaskCancelMessage,
      },
      {
        name: 'get_messages',
        msg: { type: 'get_messages', request_id: 'r1', session_id: 's1', limit: 50 } as GetMessagesMessage,
      },
      {
        name: 'watch_session',
        msg: { type: 'watch_session', session_id: 's1', file_path: '/tmp/session.jsonl' } as WatchSessionMessage,
      },
      {
        name: 'unwatch_session',
        msg: { type: 'unwatch_session', session_id: 's1' } as UnwatchSessionMessage,
      },
      {
        name: 'context_request',
        msg: {
          type: 'context_request',
          request_id: 'r1',
          session_id: 's1',
          include: { initial_prompt: true, recent_messages: 5 },
        } as ContextRequestMessage,
      },
      {
        name: 'version_status',
        msg: {
          type: 'version_status',
          status: 'current',
          your_version: '1.0.0',
        } as VersionStatusMessage,
      },
    ];

    test.each(cases)('$name has correct type discriminator', ({ msg }) => {
      expect(msg.type).toBeDefined();
      expect(typeof msg.type).toBe('string');
    });
  });

  describe('DaemonMessage variants', () => {
    const cases: Array<{ name: string; msg: DaemonMessage }> = [
      {
        name: 'pong',
        msg: { type: 'pong' } as PongMessage,
      },
      {
        name: 'status',
        msg: { type: 'status', running_tasks: ['t1', 't2'] } as StatusMessage,
      },
      {
        name: 'event',
        msg: { type: 'event', task_id: 't1', event_type: 'PROGRESS', action: 'Reading', target: 'file.ts' } as EventMessage,
      },
      {
        name: 'report_sessions',
        msg: {
          type: 'report_sessions',
          sessions: [{
            session_id: 's1', slug: 'test', title: 'Test', project: '/tmp',
            project_name: 'test', file_path: '/tmp/s.jsonl', last_message: 'hi',
            last_activity: '2026-01-01T00:00:00Z', is_active: true, message_count: 1,
          }],
        } as ReportSessionsMessage,
      },
      {
        name: 'messages',
        msg: {
          type: 'messages',
          request_id: 'r1',
          session_id: 's1',
          messages: [{ uuid: 'u1', role: 'USER', content: 'hello', timestamp: '2026-01-01T00:00:00Z' }],
          has_more: false,
        } as MessagesResponseMessage,
      },
      {
        name: 'session_activity',
        msg: {
          type: 'session_activity',
          session_id: 's1',
          file_path: '/tmp/s.jsonl',
          last_message: 'done',
          message_count: 5,
          is_completion: true,
          last_activity: '2026-01-01T00:00:00Z',
        } as SessionActivityMessage,
      },
      {
        name: 'context_response',
        msg: {
          type: 'context_response',
          request_id: 'r1',
          session_id: 's1',
          context: {
            title: 'Test',
            project_path: '/tmp',
            message_count: 1,
            last_activity_at: '2026-01-01T00:00:00Z',
            status: 'working' as SessionStatus,
          },
        } as ContextResponseMessage,
      },
    ];

    test.each(cases)('$name has correct type discriminator', ({ msg }) => {
      expect(msg.type).toBeDefined();
      expect(typeof msg.type).toBe('string');
    });
  });

  test('SessionStatus values are valid strings', () => {
    const validStatuses: SessionStatus[] = ['working', 'waiting_for_input', 'completed', 'errored', 'stale'];
    validStatuses.forEach(s => expect(typeof s).toBe('string'));
  });

  test('EventType values are valid strings', () => {
    const validTypes: EventType[] = [
      'SESSION_STARTED', 'WAIT_FOR_USER', 'TASK_COMPLETE', 'OUTPUT',
      'PROGRESS', 'ERROR', 'AGENT_RESPONSE', 'VERBOSE', 'USER_MESSAGE',
    ];
    validTypes.forEach(t => expect(typeof t).toBe('string'));
  });
});
