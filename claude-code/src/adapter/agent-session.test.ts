/**
 * Tests for AgentSession. The SDK's query() is mocked so the session can be
 * driven event by event without launching the real CLI.
 */

import type { SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AskUserInput, StreamEvent } from './events';

type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>
) => Promise<PermissionResult>;

/** The last query() call's captured arguments, for the test to drive. */
interface FakeQuery {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
  canUseTool: CanUseTool;
  emit: (event: StreamEvent) => void;
  fail: (err: Error) => void;
  end: () => void;
  interruptCalls: number;
  interruptResolves: boolean;
}

let current: FakeQuery;

jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: AsyncIterable<SDKUserMessage>; options: Record<string, unknown> }) => {
    const pendingEvents: StreamEvent[] = [];
    let waiter: (() => void) | null = null;
    let failure: Error | null = null;
    let done = false;

    const wake = () => {
      const w = waiter;
      waiter = null;
      w?.();
    };

    const fake: FakeQuery = {
      prompt: args.prompt,
      options: args.options,
      canUseTool: args.options.canUseTool as CanUseTool,
      emit: (event) => { pendingEvents.push(event); wake(); },
      fail: (err) => { failure = err; wake(); },
      end: () => { done = true; wake(); },
      interruptCalls: 0,
      interruptResolves: true,
    };
    current = fake;

    const iterator: AsyncIterableIterator<StreamEvent> = {
      [Symbol.asyncIterator]() { return this; },
      async next(): Promise<IteratorResult<StreamEvent>> {
        for (;;) {
          if (pendingEvents.length > 0) {
            return { value: pendingEvents.shift()!, done: false };
          }
          if (failure) throw failure;
          if (done) return { value: undefined as never, done: true };
          await new Promise<void>((resolve) => { waiter = resolve; });
        }
      },
    };

    return Object.assign(iterator, {
      interrupt: () => {
        fake.interruptCalls++;
        return fake.interruptResolves
          ? Promise.resolve()
          : new Promise<void>(() => { /* never settles */ });
      },
    });
  },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AgentSession, ALLOWED_TOOLS } = require('./agent-session') as typeof import('./agent-session');

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Harness {
  session: InstanceType<typeof AgentSession>;
  events: Array<{ taskId: string; event: StreamEvent }>;
  questions: Array<{ taskId: string; sessionId: string; input: AskUserInput }>;
  errors: Array<{ taskId: string; error: Error }>;
  closed: string[];
  fake: FakeQuery;
}

const build = (overrides: Partial<{ resume: string; questionTimeoutMs: number }> = {}): Harness => {
  const events: Harness['events'] = [];
  const questions: Harness['questions'] = [];
  const errors: Harness['errors'] = [];
  const closed: string[] = [];

  const session = new AgentSession({
    taskId: 'task-1',
    questionTimeoutMs: 1000,
    onStreamEvent: (taskId, event) => events.push({ taskId, event }),
    onQuestion: (taskId, sessionId, input) => questions.push({ taskId, sessionId, input }),
    onError: (taskId, error) => errors.push({ taskId, error }),
    onClosed: (sessionId) => closed.push(sessionId),
    ...overrides,
  });

  return { session, events, questions, errors, closed, fake: current };
};

const askInput = (): AskUserInput => ({
  questions: [{
    question: 'Which branch?',
    header: 'Branch',
    options: [{ label: 'main', description: 'the default' }, { label: 'dev', description: 'the other' }],
    multiSelect: false,
  }],
});

describe('AgentSession', () => {
  it('omits AskUserQuestion from the allowlist so canUseTool still fires', () => {
    expect(ALLOWED_TOOLS).not.toContain('AskUserQuestion');
    expect(ALLOWED_TOOLS).toContain('Bash');
  });

  describe('construction', () => {
    const cases: Array<{
      name: string;
      resume?: string;
      wantSessionId: string;
      wantResumeOption: string | undefined;
    }> = [
      { name: 'new session starts with no id', resume: undefined, wantSessionId: '', wantResumeOption: undefined },
      { name: 'resumed session adopts the id up front', resume: 'sess-abc', wantSessionId: 'sess-abc', wantResumeOption: 'sess-abc' },
    ];

    for (const c of cases) {
      it(c.name, () => {
        const h = build(c.resume ? { resume: c.resume } : {});
        expect(h.session.sessionId).toBe(c.wantSessionId);
        expect(h.fake.options.resume).toBe(c.wantResumeOption);
        h.session.close();
      });
    }
  });

  it('adopts the session id from a system event and forwards the event', async () => {
    const h = build();
    h.fake.emit({ type: 'system', subtype: 'init', session_id: 'sess-new' } as StreamEvent);
    await flush();

    expect(h.session.sessionId).toBe('sess-new');
    expect(h.events).toHaveLength(1);
    expect(h.events[0].taskId).toBe('task-1');
    h.session.close();
  });

  describe('send', () => {
    const cases: Array<{ name: string; text: string; images?: string[]; wantContent: unknown }> = [
      { name: 'plain text becomes a string body', text: 'hello', wantContent: 'hello' },
      {
        name: 'images become content blocks ahead of the text',
        text: 'look',
        images: ['data:image/png;base64,QUJD'],
        wantContent: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
          { type: 'text', text: 'look' },
        ],
      },
    ];

    for (const c of cases) {
      it(c.name, async () => {
        const h = build();
        h.session.send('task-2', c.text, c.images);

        const iter = h.fake.prompt[Symbol.asyncIterator]();
        const first = await iter.next();
        expect(first.done).toBe(false);
        expect(first.value.message.content).toEqual(c.wantContent);
        expect(h.session.taskId).toBe('task-2');
        h.session.close();
      });
    }

    it('rejects a send after close', () => {
      const h = build();
      h.session.close();
      expect(() => h.session.send('task-2', 'hi')).toThrow(/closed/);
    });
  });

  describe('permissions', () => {
    it('denies tools other than AskUserQuestion', async () => {
      const h = build();
      const result = await h.fake.canUseTool('WebFetch', { url: 'https://example.com' });

      expect(result).toEqual({ behavior: 'deny', message: 'WebFetch requires approval.' });
      expect(h.questions).toHaveLength(0);
      h.session.close();
    });

    it('parks AskUserQuestion and resolves it with the answer', async () => {
      const h = build();
      h.fake.emit({ type: 'system', subtype: 'init', session_id: 'sess-1' } as StreamEvent);
      await flush();

      const decision = h.fake.canUseTool('AskUserQuestion', askInput() as unknown as Record<string, unknown>);
      await flush();

      expect(h.questions).toHaveLength(1);
      expect(h.questions[0].sessionId).toBe('sess-1');
      expect(h.session.hasOpenQuestion()).toBe(true);

      expect(h.session.answerQuestion('task-3', 'dev')).toBe(true);
      const result = await decision;
      expect(result.behavior).toBe('allow');
      expect(h.session.hasOpenQuestion()).toBe(false);
      h.session.close();
    });

    it('answerQuestion returns false when nothing is parked', () => {
      const h = build();
      expect(h.session.answerQuestion('task-3', 'dev')).toBe(false);
      h.session.close();
    });

    it('cancels a parked question when the session id changes underneath it', async () => {
      const h = build();
      const decision = h.fake.canUseTool('AskUserQuestion', askInput() as unknown as Record<string, unknown>);
      await flush();
      expect(h.session.hasOpenQuestion()).toBe(true);

      h.fake.emit({ type: 'system', subtype: 'init', session_id: 'sess-late' } as StreamEvent);
      await flush();

      const result = await decision;
      expect(result.behavior).toBe('deny');
      expect(h.session.hasOpenQuestion()).toBe(false);
      h.session.close();
    });
  });

  describe('interrupt', () => {
    it('resolves through the SDK when the child responds', async () => {
      const h = build();
      await h.session.interrupt(50);
      expect(h.fake.interruptCalls).toBe(1);
      h.session.close();
    });

    it('falls back to abort when interrupt never settles', async () => {
      const h = build();
      h.fake.interruptResolves = false;
      await h.session.interrupt(20);

      expect(h.fake.interruptCalls).toBe(1);
      expect(h.fake.options.abortController).toBeDefined();
      expect((h.fake.options.abortController as AbortController).signal.aborted).toBe(true);
      h.session.close();
    });

    it('cancels an open question', async () => {
      const h = build();
      const decision = h.fake.canUseTool('AskUserQuestion', askInput() as unknown as Record<string, unknown>);
      await flush();

      await h.session.interrupt(50);
      const result = await decision;
      expect(result.behavior).toBe('deny');
      h.session.close();
    });
  });

  describe('consume loop', () => {
    it('reports a genuine stream failure as an error', async () => {
      const h = build();
      h.fake.fail(new Error('transport died'));
      await flush();

      expect(h.errors).toHaveLength(1);
      expect(h.errors[0].error.message).toBe('transport died');
      expect(h.session.isClosed).toBe(true);
    });

    it('treats a throw after abort as a cancel, not an error', async () => {
      const h = build();
      h.session.close();
      h.fake.fail(new Error('aborted'));
      await flush();

      expect(h.errors).toHaveLength(0);
    });

    it('reports closure once the stream ends', async () => {
      const h = build({ resume: 'sess-end' });
      h.fake.end();
      await flush();

      expect(h.closed).toEqual(['sess-end']);
      expect(h.session.isClosed).toBe(true);
    });
  });
});
