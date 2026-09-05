import { describeAppServerError, isThreadMissing } from './codex-cli';
import { AppServerError } from './app-server-client';

/**
 * Codex allows one writer per thread, so a user with the session open in their
 * own terminal is the ordinary case, not an edge case. What they saw was
 * "-32600 thread <uuid> already has an active writer", which names neither the
 * terminal they have to close nor anything else they can act on.
 */
describe('describeAppServerError', () => {
  const cases: { name: string; err: unknown; expected: string }[] = [
    {
      name: 'the writer conflict points at the terminal holding the session',
      err: new AppServerError(
        'thread/resume',
        -32600,
        'thread 01a072de-9966-7240-bf78-2ecc1e5ff96d already has an active writer',
      ),
      expected:
        'It appears that this session is open in your terminal. Cmd+Ctrl cannot interact with it as long as it is open there.',
    },
    {
      name: 'the local-writer wording maps to the same explanation',
      err: new AppServerError(
        'thread/resume',
        -32600,
        'thread 01a072de already has a live local writer',
      ),
      expected:
        'It appears that this session is open in your terminal. Cmd+Ctrl cannot interact with it as long as it is open there.',
    },
    {
      name: 'a turn already in flight is a wait, not a close',
      err: new AppServerError(
        'turn/start',
        -32600,
        'thread already has an active or pending turn',
      ),
      expected:
        'This session is already working on something. Wait for it to finish, then try again.',
    },
    {
      name: 'an unrecognised server error keeps its text but loses the code',
      err: new AppServerError('turn/start', -32602, 'cwd must be absolute'),
      expected: 'cwd must be absolute',
    },
    {
      name: 'a plain Error passes its message through',
      err: new Error('AppServerClient not ready (request: turn/start)'),
      expected: 'AppServerClient not ready (request: turn/start)',
    },
    {
      name: 'a non-Error throw is stringified rather than dropped',
      err: 'something went sideways',
      expected: 'something went sideways',
    },
  ];

  test.each(cases)('$name', ({ err, expected }) => {
    expect(describeAppServerError(err)).toBe(expected);
  });

  test('no explanation leaks the JSON-RPC code to the user', () => {
    for (const { err } of cases) {
      expect(describeAppServerError(err)).not.toMatch(/-32\d{3}/);
    }
  });
});

/**
 * A missing thread is recoverable – the adapter starts a fresh session. A busy
 * one is not, and must never be mistaken for it, or a locked thread would
 * silently fork a new session and strand the user's history.
 */
describe('isThreadMissing', () => {
  const cases: { name: string; message: string; expected: boolean }[] = [
    {
      name: 'the 0.153 wording for an absent rollout',
      message: 'no rollout found for thread id 01a072de-9966-7240',
      expected: true,
    },
    { name: 'thread not found', message: 'thread not found', expected: true },
    {
      name: 'no such thread',
      message: 'no such thread: 01a072de',
      expected: true,
    },
    { name: 'no session', message: 'no session on disk', expected: true },
    {
      name: 'an active writer is busy, not missing',
      message: 'thread 01a072de already has an active writer',
      expected: false,
    },
    {
      name: 'a live local writer is busy, not missing',
      message: 'thread 01a072de already has a live local writer',
      expected: false,
    },
    {
      name: 'an in-flight turn is busy, not missing',
      message: 'thread already has an active or pending turn',
      expected: false,
    },
    {
      name: 'an unrelated failure is not a missing thread',
      message: 'cwd must be absolute',
      expected: false,
    },
  ];

  test.each(cases)('$name', ({ message, expected }) => {
    expect(isThreadMissing(new AppServerError('thread/resume', -32600, message)))
      .toBe(expected);
  });

  test('reads a plain Error too, so a transport failure is classified alike', () => {
    expect(isThreadMissing(new Error('no rollout found for thread id x'))).toBe(
      true,
    );
    expect(isThreadMissing(new Error('already has an active writer'))).toBe(
      false,
    );
  });
});

describe('AppServerError', () => {
  const err = new AppServerError('thread/resume', -32600, 'already has an active writer');

  test('keeps the server text separate from the framed message', () => {
    expect(err.serverMessage).toBe('already has an active writer');
    expect(err.message).toBe(
      'thread/resume: -32600 already has an active writer',
    );
    expect(err.code).toBe(-32600);
    expect(err.method).toBe('thread/resume');
  });

  test('is an Error, so existing catch/instanceof paths still hold', () => {
    expect(err).toBeInstanceOf(Error);
  });
});
